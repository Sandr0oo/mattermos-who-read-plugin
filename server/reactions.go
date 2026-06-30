package main

import (
	"github.com/mattermost/mattermost/server/public/model"
)

type mirrorEmojiStatus struct {
	ConfiguredEmojiName string `json:"configured_emoji_name"`
	ConfiguredAvailable bool   `json:"configured_available"`
	EffectiveEmojiName  string `json:"effective_emoji_name"`
	EffectiveAvailable  bool   `json:"effective_available"`
	FallbackUsed        bool   `json:"fallback_used"`
	FallbackEmojiName   string `json:"fallback_emoji_name,omitempty"`
	Error               string `json:"error,omitempty"`
}

func (p *Plugin) shouldManageMirrorReactions(configuration *configuration) bool {
	return configuration != nil && configuration.ReadReceiptMode == ModeHybridServer && configuration.MirrorReactionsEnabled
}

func (p *Plugin) resolveMirrorEmojiStatus(configuration *configuration) mirrorEmojiStatus {
	if configuration == nil {
		configuration = defaultConfiguration()
	}

	configuredEmojiName := normalizeEmojiName(configuration.MirrorEmojiName)
	if configuredEmojiName == "" {
		configuredEmojiName = defaultMirrorEmojiName
	}

	status := mirrorEmojiStatus{
		ConfiguredEmojiName: configuredEmojiName,
		EffectiveEmojiName:  configuredEmojiName,
	}

	if configuredEmojiName == standardEyesEmojiName {
		status.ConfiguredAvailable = true
		status.EffectiveAvailable = true
		return status
	}

	if p.API != nil {
		emoji, appErr := p.API.GetEmojiByName(configuredEmojiName)
		if appErr == nil && emoji != nil && emoji.DeleteAt == 0 {
			status.ConfiguredAvailable = true
			status.EffectiveAvailable = true
			return status
		}
		if appErr != nil {
			status.Error = appErr.Error()
		}
	}

	if configuration.FallbackToStandardEyes {
		status.EffectiveEmojiName = standardEyesEmojiName
		status.EffectiveAvailable = true
		status.FallbackUsed = true
		status.FallbackEmojiName = standardEyesEmojiName
	}

	return status
}

func (p *Plugin) applyMirrorReactionMove(userID, channelID, previousPostID, currentPostID, previousEmojiName, currentEmojiName string) string {
	result := "unchanged"

	if previousPostID != "" && previousPostID != currentPostID {
		if previousEmojiName == "" {
			previousEmojiName = currentEmojiName
		}
		if previousEmojiName != "" {
			removeResult, err := p.removeMirrorReaction(previousPostID, userID, previousEmojiName)
			if err != nil {
				return "remove_error"
			}
			result = "previous_" + removeResult
		}
	}

	if previousPostID == currentPostID && currentPostID != "" && previousEmojiName != "" && currentEmojiName != "" && previousEmojiName != currentEmojiName {
		if _, err := p.removeMirrorReaction(currentPostID, userID, previousEmojiName); err != nil {
			return "remove_error"
		}
	}

	if currentPostID != "" {
		if currentEmojiName == "" {
			return "skipped_missing_emoji"
		}
		addResult, err := p.ensureMirrorReaction(currentPostID, channelID, userID, currentEmojiName)
		if err != nil {
			return "add_error"
		}
		return addResult
	}

	if result == "unchanged" {
		return "skipped_own_post"
	}

	return result
}

func (p *Plugin) ensureMirrorReaction(postID, channelID, userID, emojiName string) (string, error) {
	if p.API == nil || emojiName == "" {
		return "skipped", nil
	}

	reactions, appErr := p.API.GetReactions(postID)
	if appErr != nil {
		return "", appErr
	}
	if hasReaction(reactions, postID, userID, emojiName) {
		return "already_present", nil
	}

	now := model.GetMillis()
	_, appErr = p.API.AddReaction(&model.Reaction{
		UserId:    userID,
		PostId:    postID,
		EmojiName: emojiName,
		CreateAt:  now,
		UpdateAt:  now,
		ChannelId: channelID,
	})
	if appErr != nil {
		return "", appErr
	}

	return "added", nil
}

func (p *Plugin) removeMirrorReaction(postID, userID, emojiName string) (string, error) {
	if p.API == nil || emojiName == "" {
		return "skipped", nil
	}

	reactions, appErr := p.API.GetReactions(postID)
	if appErr != nil {
		return "", appErr
	}
	if !hasReaction(reactions, postID, userID, emojiName) {
		return "not_present", nil
	}

	appErr = p.API.RemoveReaction(&model.Reaction{
		UserId:    userID,
		PostId:    postID,
		EmojiName: emojiName,
	})
	if appErr != nil {
		return "", appErr
	}

	return "removed", nil
}

func hasReaction(reactions []*model.Reaction, postID, userID, emojiName string) bool {
	for _, reaction := range reactions {
		if reaction == nil {
			continue
		}
		if reaction.PostId == postID && reaction.UserId == userID && reaction.EmojiName == emojiName && reaction.DeleteAt == 0 {
			return true
		}
	}
	return false
}
