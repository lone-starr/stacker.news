import serialize from '../api/resolvers/serial.js'
import {
  getInvoice, getPayment, cancelHodlInvoice,
  subscribeToInvoices, subscribeToPayments, subscribeToInvoice
} from 'ln-service'
import { sendUserNotification } from '../api/webPush/index.js'
import { msatsToSats, numWithUnits } from '../lib/format'
import { INVOICE_RETENTION_DAYS } from '../lib/constants'
import { sleep } from '../lib/time.js'

export async function subscribeToWallet (args) {
  await subscribeToDeposits(args)
  await subscribeToWithdrawals(args)
}

const logEvent = (name, args) => console.log(`event ${name} triggered with args`, args)
const logEventError = (name, error) => console.error(`error running ${name}`, error)

async function subscribeToDeposits (args) {
  const { models, lnd } = args

  const [lastConfirmed] = await models.$queryRaw`
    SELECT "confirmedIndex"
    FROM "Invoice"
    ORDER BY "confirmedIndex" DESC NULLS LAST
    LIMIT 1`

  // https://www.npmjs.com/package/ln-service#subscribetoinvoices
  const sub = subscribeToInvoices({ lnd, confirmed_after: lastConfirmed?.confirmedIndex })
  sub.on('invoice_updated', async (inv) => {
    try {
      if (inv.secret) {
        logEvent('invoice_updated', inv)
        await checkInvoice({ data: { hash: inv.id }, ...args })
      } else {
        // this is a HODL invoice. We need to use SubscribeToInvoice which has is_held transitions
        // https://api.lightning.community/api/lnd/invoices/subscribe-single-invoice
        // SubscribeToInvoices is only for invoice creation and settlement transitions
        // https://api.lightning.community/api/lnd/lightning/subscribe-invoices
        await subscribeToHodlInvoice({ hash: inv.id, ...args })
      }
    } catch (error) {
      // XXX This is a critical error
      // It might mean that we failed to record an invoice confirming
      // and we won't get another chance to record it until restart
      logEventError('invoice_updated', error)
    }
  })
  sub.on('error', console.error)

  // check pending deposits as a redundancy in case we failed to record
  // an invoice_updated event
  await checkPendingDeposits(args)
}

async function subscribeToHodlInvoice (args) {
  const { lnd, hash, models } = args
  let sub
  try {
    await new Promise((resolve, reject) => {
      // https://www.npmjs.com/package/ln-service#subscribetoinvoice
      sub = subscribeToInvoice({ id: hash, lnd })
      sub.on('invoice_updated', async (inv) => {
        logEvent('hodl_invoice_updated', inv)
        try {
          // record the is_held transition
          if (inv.is_held) {
            // this is basically confirm_invoice without setting confirmed_at
            // and without setting the user balance
            // those will be set when the invoice is settled by user action
            await models.invoice.update({
              where: { hash },
              data: {
                msatsReceived: Number(inv.received_mtokens),
                isHeld: true
              }
            })
            // after that we can stop listening for updates
            resolve()
          }
        } catch (error) {
          logEventError('hodl_invoice_updated', error)
          reject(error)
        }
      })
      sub.on('error', reject)
    })
  } finally {
    sub?.removeAllListeners()
  }
}

async function checkInvoice ({ data: { hash }, boss, models, lnd }) {
  const inv = await getInvoice({ id: hash, lnd })

  // invoice could be created by LND but wasn't inserted into the database yet
  // this is expected and the function will be called again with the updates
  const dbInv = await models.invoice.findUnique({ where: { hash } })
  if (!dbInv) {
    console.log('invoice not found in database', hash)
    return
  }

  if (inv.is_confirmed) {
    // NOTE: confirm invoice prevents double confirmations (idempotent)
    // ALSO: is_confirmed and is_held are mutually exclusive
    // that is, a hold invoice will first be is_held but not is_confirmed
    // and once it's settled it will be is_confirmed but not is_held
    await serialize(models,
      models.$executeRaw`SELECT confirm_invoice(${inv.id}, ${Number(inv.received_mtokens)})`,
      models.invoice.update({ where: { hash }, data: { confirmedIndex: inv.confirmed_index } })
    )

    // don't send notifications for hodl invoices
    if (dbInv.preimage) return

    sendUserNotification(dbInv.userId, {
      title: `${numWithUnits(msatsToSats(inv.received_mtokens), { abbreviate: false })} were deposited in your account`,
      body: dbInv.comment || undefined,
      tag: 'DEPOSIT',
      data: { sats: msatsToSats(inv.received_mtokens) }
    }).catch(console.error)
    return await boss.send('nip57', { hash })
  }

  if (inv.is_canceled) {
    return await serialize(models,
      models.invoice.update({
        where: {
          hash: inv.id
        },
        data: {
          cancelled: true
        }
      }))
  }
}

async function subscribeToWithdrawals (args) {
  const { lnd } = args

  // https://www.npmjs.com/package/ln-service#subscribetopayments
  const sub = subscribeToPayments({ lnd })
  sub.on('confirmed', async (payment) => {
    logEvent('confirmed', payment)
    try {
      await checkWithdrawal({ data: { hash: payment.id }, ...args })
    } catch (error) {
      // XXX This is a critical error
      // It might mean that we failed to record an invoice confirming
      // and we won't get another chance to record it until restart
      logEventError('confirmed', error)
    }
  })
  sub.on('failed', async (payment) => {
    logEvent('failed', payment)
    try {
      await checkWithdrawal({ data: { hash: payment.id }, ...args })
    } catch (error) {
      // XXX This is a critical error
      // It might mean that we failed to record an invoice confirming
      // and we won't get another chance to record it until restart
      logEventError('failed', error)
    }
  })
  // ignore payment attempts
  sub.on('paying', (attempt) => {})
  sub.on('error', console.error)

  // check pending withdrawals since they might have been paid while worker was down
  await checkPendingWithdrawals(args)
}

async function checkWithdrawal ({ data: { hash }, boss, models, lnd }) {
  const dbWdrwl = await models.withdrawl.findFirst({ where: { hash } })
  if (!dbWdrwl) {
    // [WARNING] LND paid an invoice that wasn't created via the SN GraphQL API.
    // >>> an adversary might be draining our funds right now <<<
    console.error('unexpected outgoing payment detected:', hash)
    // TODO: log this in Slack
    return
  }

  let wdrwl
  let notFound = false
  try {
    wdrwl = await getPayment({ id: hash, lnd })
  } catch (err) {
    if (err[1] === 'SentPaymentNotFound') {
      notFound = true
    } else {
      console.error('error getting payment', err)
      return
    }
  }

  if (wdrwl?.is_confirmed) {
    const fee = Number(wdrwl.payment.fee_mtokens)
    const paid = Number(wdrwl.payment.mtokens) - fee
    await serialize(models, models.$executeRaw`
      SELECT confirm_withdrawl(${dbWdrwl.id}::INTEGER, ${paid}, ${fee})`)
  } else if (wdrwl?.is_failed || notFound) {
    let status = 'UNKNOWN_FAILURE'
    if (wdrwl?.failed.is_insufficient_balance) {
      status = 'INSUFFICIENT_BALANCE'
    } else if (wdrwl?.failed.is_invalid_payment) {
      status = 'INVALID_PAYMENT'
    } else if (wdrwl?.failed.is_pathfinding_timeout) {
      status = 'PATHFINDING_TIMEOUT'
    } else if (wdrwl?.failed.is_route_not_found) {
      status = 'ROUTE_NOT_FOUND'
    }

    await serialize(models,
      models.$executeRaw`
        SELECT reverse_withdrawl(${dbWdrwl.id}::INTEGER, ${status}::"WithdrawlStatus")`
    )
  }
}

export async function autoDropBolt11s ({ models }) {
  await serialize(models, models.$executeRaw`
    UPDATE "Withdrawl"
    SET hash = NULL, bolt11 = NULL
    WHERE "userId" IN (SELECT id FROM users WHERE "autoDropBolt11s")
    AND now() > created_at + interval '${INVOICE_RETENTION_DAYS} days'
    AND hash IS NOT NULL;`
  )
}

// The callback subscriptions above will NOT get called for HODL invoices that are already paid.
// So we manually cancel the HODL invoice here if it wasn't settled by user action
export async function finalizeHodlInvoice ({ data: { hash }, models, lnd }) {
  const inv = await getInvoice({ id: hash, lnd })
  if (inv.is_confirmed) {
    return
  }

  await cancelHodlInvoice({ id: hash, lnd })
}

export async function checkPendingDeposits (args) {
  const { models } = args
  const pendingDeposits = await models.invoice.findMany({ where: { confirmedAt: null, cancelled: false } })
  for (const d of pendingDeposits) {
    try {
      await checkInvoice({ data: { id: d.id, hash: d.hash }, ...args })
      await sleep(10)
    } catch {
      console.error('error checking invoice', d.hash)
    }
  }
}

export async function checkPendingWithdrawals (args) {
  const { models } = args
  const pendingWithdrawals = await models.withdrawl.findMany({ where: { status: null } })
  for (const w of pendingWithdrawals) {
    try {
      await checkWithdrawal({ data: { id: w.id, hash: w.hash }, ...args })
      await sleep(10)
    } catch {
      console.error('error checking withdrawal', w.hash)
    }
  }
}
