package main

import "github.com/mattermost/mattermost/server/public/model"

const (
	websocketEventReadReceiptUpdated       = "read_receipt_updated"
	websocketEventReadReceiptConfigChanged = "read_receipt_config_changed"
)

func (p *Plugin) publishReadReceiptUpdated(result *readStateResult) {
	if p.API == nil || result == nil {
		return
	}

	payload := map[string]any{
		"scope_type":       string(result.ScopeType),
		"scope_id":         result.ScopeID,
		"channel_id":       result.ChannelID,
		"post_id":          result.PostID,
		"previous_post_id": result.PreviousPostID,
		"updated_at":       result.UpdatedAt,
	}

	p.API.PublishWebSocketEvent(websocketEventReadReceiptUpdated, payload, &model.WebsocketBroadcast{ChannelId: result.ChannelID})
}

func (p *Plugin) publishConfigChanged() {
	if p.API == nil {
		return
	}

	p.API.PublishWebSocketEvent(websocketEventReadReceiptConfigChanged, map[string]any{
		"updated_at": model.GetMillis(),
	}, &model.WebsocketBroadcast{})
}
