// voice.js — owner controls for Join to Create temporary voice channels.
//
// This complements jointocreate.js (which is the admin-only setup/dashboard
// command) with a member-facing command that lets whoever owns a temporary
// voice channel rename it, lock/unlock it, and control exactly who is allowed
// to join while it's locked.

import {
    SlashCommandBuilder,
    PermissionFlagsBits,
    MessageFlags,
} from 'discord.js';
import { successEmbed, warningEmbed, errorEmbed } from '../../utils/embeds.js';
import { logger } from '../../utils/logger.js';
import { TitanBotError, ErrorTypes, replyUserError } from '../../utils/errorHandler.js';
import { InteractionHelper } from '../../utils/interactionHelper.js';
import { sanitizeInput } from '../../utils/validation.js';
import {
    getTemporaryChannelInfo,
    updateTemporaryChannelInfo,
    validateUserLimit,
} from '../../utils/database.js';

const MAX_CHANNEL_NAME_LENGTH = 100;
const MAX_ALLOWED_USERS = 25;

export default {
    data: new SlashCommandBuilder()
        .setName('voice')
        .setDescription('Manage your own temporary Join to Create voice channel.')
        .setDMPermission(false)
        .addSubcommand((sub) =>
            sub
                .setName('rename')
                .setDescription('Rename your temporary voice channel.')
                .addStringOption((option) =>
                    option
                        .setName('name')
                        .setDescription('New name for your channel.')
                        .setRequired(true)
                        .setMaxLength(MAX_CHANNEL_NAME_LENGTH)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('lock')
                .setDescription('Lock your channel so only permitted users can join.')
        )
        .addSubcommand((sub) =>
            sub
                .setName('unlock')
                .setDescription('Unlock your channel so anyone can join.')
        )
        .addSubcommand((sub) =>
            sub
                .setName('limit')
                .setDescription('Set a user limit for your channel.')
                .addIntegerOption((option) =>
                    option
                        .setName('number')
                        .setDescription('Max users allowed (0 = unlimited).')
                        .setMinValue(0)
                        .setMaxValue(99)
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('permit')
                .setDescription('Allow a specific user to join your locked channel.')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User to allow in.')
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('reject')
                .setDescription('Remove a user\'s access and disconnect them from your channel.')
                .addUserOption((option) =>
                    option
                        .setName('user')
                        .setDescription('User to remove.')
                        .setRequired(true)
                )
        )
        .addSubcommand((sub) =>
            sub
                .setName('claim')
                .setDescription('Claim ownership of this channel if the owner has left.')
        ),
    category: 'JoinToCreate',

    async execute(interaction, config, client) {
        try {
            await InteractionHelper.safeDefer(interaction, { flags: MessageFlags.Ephemeral });

            const subcommand = interaction.options.getSubcommand();
            const guildId = interaction.guild.id;
            const member = interaction.member;
            const voiceChannel = member.voice?.channel;

            if (!voiceChannel) {
                throw new TitanBotError(
                    'User not in a voice channel',
                    ErrorTypes.VALIDATION,
                    'You need to be in your temporary voice channel to use this command.'
                );
            }

            const tempInfo = await getTemporaryChannelInfo(client, guildId, voiceChannel.id);

            if (!tempInfo) {
                throw new TitanBotError(
                    'Channel is not a temporary Join to Create channel',
                    ErrorTypes.VALIDATION,
                    'This isn\'t a temporary voice channel created by Join to Create.'
                );
            }

            if (subcommand === 'claim') {
                await handleClaim(interaction, voiceChannel, tempInfo, guildId, client);
                return;
            }

            if (tempInfo.ownerId !== member.id) {
                throw new TitanBotError(
                    'User does not own this temporary channel',
                    ErrorTypes.PERMISSION,
                    'Only the owner of this channel can do that. Use `/voice claim` if the owner has left.'
                );
            }

            switch (subcommand) {
                case 'rename':
                    await handleRename(interaction, voiceChannel);
                    break;
                case 'lock':
                    await handleLock(interaction, voiceChannel, tempInfo, guildId, client);
                    break;
                case 'unlock':
                    await handleUnlock(interaction, voiceChannel, tempInfo, guildId, client);
                    break;
                case 'limit':
                    await handleLimit(interaction, voiceChannel);
                    break;
                case 'permit':
                    await handlePermit(interaction, voiceChannel, tempInfo, guildId, client);
                    break;
                case 'reject':
                    await handleReject(interaction, voiceChannel, tempInfo, guildId, client);
                    break;
            }

        } catch (error) {
            if (error instanceof TitanBotError) {
                return replyUserError(interaction, { type: error.type, message: error.userMessage });
            }

            logger.error('Unexpected error in voice command:', error);
            return replyUserError(interaction, {
                type: ErrorTypes.UNKNOWN,
                message: 'An unexpected error occurred while managing your voice channel.',
            });
        }
    },
};

async function handleRename(interaction, voiceChannel) {
    const rawName = interaction.options.getString('name');
    const name = sanitizeInput(rawName, MAX_CHANNEL_NAME_LENGTH).trim();

    if (!name) {
        throw new TitanBotError(
            'Empty channel name after sanitization',
            ErrorTypes.VALIDATION,
            'Please provide a valid channel name.'
        );
    }

    await voiceChannel.setName(name, 'Renamed by channel owner via /voice rename');

    await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Channel Renamed', `Your channel is now named **${name}**.`)],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleLock(interaction, voiceChannel, tempInfo, guildId, client) {
    await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        Connect: false,
    });

    // Make sure the owner and anyone already permitted can still get back in.
    await voiceChannel.permissionOverwrites.edit(tempInfo.ownerId, {
        Connect: true,
        Speak: true,
    });

    for (const allowedUserId of tempInfo.allowedUsers || []) {
        await voiceChannel.permissionOverwrites.edit(allowedUserId, { Connect: true }).catch(() => {});
    }

    await updateTemporaryChannelInfo(client, guildId, voiceChannel.id, { locked: true });

    await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('🔒 Channel Locked', 'Only you and permitted users can join now. Use `/voice permit` to allow others in.')],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleUnlock(interaction, voiceChannel, tempInfo, guildId, client) {
    await voiceChannel.permissionOverwrites.edit(interaction.guild.roles.everyone, {
        Connect: null,
    });

    await updateTemporaryChannelInfo(client, guildId, voiceChannel.id, { locked: false });

    await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('🔓 Channel Unlocked', 'Anyone can join your channel now.')],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleLimit(interaction, voiceChannel) {
    const limit = interaction.options.getInteger('number');

    try {
        validateUserLimit(limit);
    } catch {
        throw new TitanBotError(
            'Invalid user limit',
            ErrorTypes.VALIDATION,
            'User limit must be between 0 (no limit) and 99.'
        );
    }

    await voiceChannel.setUserLimit(limit, 'Updated by channel owner via /voice limit');

    await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed(
            'User Limit Updated',
            limit === 0 ? 'Your channel now has no user limit.' : `Your channel's user limit is now **${limit}**.`
        )],
        flags: MessageFlags.Ephemeral,
    });
}

async function handlePermit(interaction, voiceChannel, tempInfo, guildId, client) {
    const targetUser = interaction.options.getUser('user');

    if (targetUser.bot) {
        throw new TitanBotError(
            'Cannot permit a bot',
            ErrorTypes.VALIDATION,
            'You can\'t permit a bot into your channel.'
        );
    }

    const allowedUsers = new Set(tempInfo.allowedUsers || []);

    if (allowedUsers.size >= MAX_ALLOWED_USERS && !allowedUsers.has(targetUser.id)) {
        throw new TitanBotError(
            'Allowed user limit reached',
            ErrorTypes.VALIDATION,
            `You can only permit up to ${MAX_ALLOWED_USERS} users.`
        );
    }

    allowedUsers.add(targetUser.id);

    await voiceChannel.permissionOverwrites.edit(targetUser.id, {
        Connect: true,
        Speak: true,
    });

    await updateTemporaryChannelInfo(client, guildId, voiceChannel.id, {
        allowedUsers: Array.from(allowedUsers),
    });

    await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('User Permitted', `${targetUser} can now join your channel${tempInfo.locked ? ' even while it\'s locked' : ''}.`)],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleReject(interaction, voiceChannel, tempInfo, guildId, client) {
    const targetUser = interaction.options.getUser('user');

    if (targetUser.id === tempInfo.ownerId) {
        throw new TitanBotError(
            'Cannot reject the channel owner',
            ErrorTypes.VALIDATION,
            'You can\'t remove yourself as the owner. Use `/voice unlock` if you want to open the channel instead.'
        );
    }

    const allowedUsers = new Set(tempInfo.allowedUsers || []);
    allowedUsers.delete(targetUser.id);

    await voiceChannel.permissionOverwrites.edit(targetUser.id, { Connect: false });

    await updateTemporaryChannelInfo(client, guildId, voiceChannel.id, {
        allowedUsers: Array.from(allowedUsers),
    });

    const memberInChannel = voiceChannel.members.get(targetUser.id);
    if (memberInChannel) {
        await memberInChannel.voice.disconnect('Removed by channel owner via /voice reject').catch(() => {});
    }

    await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('User Removed', `${targetUser} no longer has access to your channel.`)],
        flags: MessageFlags.Ephemeral,
    });
}

async function handleClaim(interaction, voiceChannel, tempInfo, guildId, client) {
    const member = interaction.member;

    if (tempInfo.ownerId === member.id) {
        await InteractionHelper.safeReply(interaction, {
            embeds: [warningEmbed('Already Owner', 'You already own this channel.')],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    const ownerStillPresent = voiceChannel.members.has(tempInfo.ownerId);

    if (ownerStillPresent) {
        await InteractionHelper.safeReply(interaction, {
            embeds: [errorEmbed('Owner Still Present', 'The current owner is still in this channel, so it can\'t be claimed.')],
            flags: MessageFlags.Ephemeral,
        });
        return;
    }

    await updateTemporaryChannelInfo(client, guildId, voiceChannel.id, { ownerId: member.id });

    await voiceChannel.permissionOverwrites.edit(member.id, {
        Connect: true,
        Speak: true,
        PrioritySpeaker: true,
        MoveMembers: true,
    });

    logger.info(`User ${member.id} claimed ownership of temporary channel ${voiceChannel.id} in guild ${guildId}`);

    await InteractionHelper.safeReply(interaction, {
        embeds: [successEmbed('Ownership Claimed', 'You are now the owner of this channel. You can use `/voice rename`, `/voice lock`, and other controls.')],
        flags: MessageFlags.Ephemeral,
    });
}
