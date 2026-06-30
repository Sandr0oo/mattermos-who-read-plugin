package main

import (
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/mock"
)

func TestPublishReadReceiptUpdatedHidesUserIDWhenReaderNamesDisabled(t *testing.T) {
	api := &plugintest.API{}
	plugin := &Plugin{}
	plugin.API = api
	configuration := defaultConfiguration()
	configuration.ShowReaderNames = false
	plugin.setConfiguration(configuration)

	channelID := model.NewId()
	postID := model.NewId()
	previousPostID := model.NewId()
	updatedAt := model.GetMillis()

	api.On("PublishWebSocketEvent", websocketEventReadReceiptUpdated, mock.MatchedBy(func(payload map[string]any) bool {
		_, hasUserID := payload["user_id"]
		return !hasUserID &&
			payload["scope_type"] == ScopeTypeChannel &&
			payload["scope_id"] == channelID &&
			payload["channel_id"] == channelID &&
			payload["post_id"] == postID &&
			payload["previous_post_id"] == previousPostID &&
			payload["updated_at"] == updatedAt
	}), mock.MatchedBy(func(broadcast *model.WebsocketBroadcast) bool {
		return broadcast != nil && broadcast.ChannelId == channelID
	})).Return().Once()

	plugin.publishReadReceiptUpdated(&readStateResult{
		UserID:         model.NewId(),
		ScopeType:      ScopeTypeChannel,
		ScopeID:        channelID,
		ChannelID:      channelID,
		PostID:         postID,
		PreviousPostID: previousPostID,
		UpdatedAt:      updatedAt,
	})

	api.AssertExpectations(t)
}
