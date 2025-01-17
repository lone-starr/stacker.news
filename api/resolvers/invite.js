import { GraphQLError } from 'graphql'
import { inviteSchema, ssValidate } from '../../lib/validate'
import { msatsToSats } from '../../lib/format'

export default {
  Query: {
    invites: async (parent, args, { me, models }) => {
      if (!me) {
        throw new GraphQLError('you must be logged in', { extensions: { code: 'FORBIDDEN' } })
      }

      return await models.invite.findMany({
        where: {
          userId: me.id
        },
        orderBy: {
          createdAt: 'desc'
        }
      })
    },
    invite: async (parent, { id }, { me, models }) => {
      return await models.invite.findUnique({
        where: {
          id
        }
      })
    }
  },

  Mutation: {
    createInvite: async (parent, { gift, limit }, { me, models }) => {
      if (!me) {
        throw new GraphQLError('you must be logged in', { extensions: { code: 'FORBIDDEN' } })
      }

      await ssValidate(inviteSchema, { gift, limit })

      return await models.invite.create({
        data: { gift, limit, userId: me.id }
      })
    },
    revokeInvite: async (parent, { id }, { me, models }) => {
      if (!me) {
        throw new GraphQLError('you must be logged in', { extensions: { code: 'FORBIDDEN' } })
      }

      return await models.invite.update({
        where: { id },
        data: { revoked: true }
      })
    }
  },

  Invite: {
    invitees: async (invite, args, { me, models }) => {
      return await models.user.findMany({ where: { inviteId: invite.id } })
    },
    user: async (invite, args, { me, models }) => {
      return await models.user.findUnique({ where: { id: invite.userId } })
    },
    poor: async (invite, args, { me, models }) => {
      const user = await models.user.findUnique({ where: { id: invite.userId } })
      return msatsToSats(user.msats) < invite.gift
    }
  }
}
