package main

import (
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func TestEnsureMirrorReactionSkipsDuplicate(t *testing.T) {
	api := &plugintest.API{}
	plugin := &Plugin{}
	plugin.API = api

	postID := model.NewId()
	userID := model.NewId()
	channelID := model.NewId()
	api.On("GetReactions", postID).Return([]*model.Reaction{{
		PostId:    postID,
		UserId:    userID,
		EmojiName: defaultMirrorEmojiName,
	}}, nil).Once()

	result, err := plugin.ensureMirrorReaction(postID, channelID, userID, defaultMirrorEmojiName)
	require.NoError(t, err)
	require.Equal(t, "already_present", result)
	api.AssertNotCalled(t, "AddReaction", mock.Anything)
}

func TestRemoveMirrorReactionOnlyWhenPresent(t *testing.T) {
	api := &plugintest.API{}
	plugin := &Plugin{}
	plugin.API = api

	postID := model.NewId()
	userID := model.NewId()
	api.On("GetReactions", postID).Return([]*model.Reaction{{
		PostId:    postID,
		UserId:    userID,
		EmojiName: defaultMirrorEmojiName,
	}}, nil).Once()
	api.On("RemoveReaction", mock.MatchedBy(func(reaction *model.Reaction) bool {
		return reaction.PostId == postID && reaction.UserId == userID && reaction.EmojiName == defaultMirrorEmojiName
	})).Return(nil).Once()

	result, err := plugin.removeMirrorReaction(postID, userID, defaultMirrorEmojiName)
	require.NoError(t, err)
	require.Equal(t, "removed", result)
	api.AssertExpectations(t)
}
