package main

import (
	"net/http"

	"github.com/mattermost/mattermost/server/public/model"
)

type ScopeType string

const (
	ScopeTypeChannel ScopeType = "channel"
	ScopeTypeThread  ScopeType = "thread"
)

type readStateRequest struct {
	ScopeType      ScopeType `json:"scope_type"`
	ChannelID      string    `json:"channel_id"`
	ThreadID       string    `json:"thread_id,omitempty"`
	LastReadPostID string    `json:"last_read_post_id"`
}

type readStateResult struct {
	UserID          string    `json:"user_id"`
	ScopeType       ScopeType `json:"scope_type"`
	ScopeID         string    `json:"scope_id"`
	ChannelID       string    `json:"channel_id"`
	PostID          string    `json:"post_id"`
	PreviousPostID  string    `json:"previous_post_id,omitempty"`
	UpdatedAt       int64     `json:"updated_at"`
	MirrorReaction  string    `json:"mirror_reaction"`
	MirrorEmojiName string    `json:"mirror_emoji_name,omitempty"`
	Changed         bool      `json:"changed"`
}

func (r readStateRequest) scopeID() string {
	if r.ScopeType == ScopeTypeThread {
		return r.ThreadID
	}
	return r.ChannelID
}

func (p *Plugin) validateReadStateRequest(userID string, request readStateRequest) (*model.Post, *httpError) {
	switch request.ScopeType {
	case ScopeTypeChannel, ScopeTypeThread:
	default:
		return nil, newHTTPError(http.StatusBadRequest, "invalid scope_type")
	}

	if httpErr := validateID("channel_id", request.ChannelID); httpErr != nil {
		return nil, httpErr
	}
	if request.ScopeType == ScopeTypeThread {
		if httpErr := validateID("thread_id", request.ThreadID); httpErr != nil {
			return nil, httpErr
		}
	}
	if httpErr := validateID("last_read_post_id", request.LastReadPostID); httpErr != nil {
		return nil, httpErr
	}

	if httpErr := p.ensureChannelMember(userID, request.ChannelID); httpErr != nil {
		return nil, httpErr
	}

	post, httpErr := p.getPost(request.LastReadPostID)
	if httpErr != nil {
		return nil, httpErr
	}
	if post.ChannelId != request.ChannelID {
		return nil, newHTTPError(http.StatusBadRequest, "post does not belong to channel")
	}

	if request.ScopeType == ScopeTypeThread && post.Id != request.ThreadID && post.RootId != request.ThreadID {
		return nil, newHTTPError(http.StatusBadRequest, "post does not belong to thread")
	}

	return post, nil
}

func (p *Plugin) markReadState(userID string, request readStateRequest, post *model.Post) (*readStateResult, *httpError) {
	store := p.getStore()
	if store == nil {
		return nil, newHTTPError(http.StatusInternalServerError, "storage is not initialized")
	}

	configuration := p.getConfiguration()
	if configuration == nil {
		configuration = defaultConfiguration()
	}

	scopeID := request.scopeID()
	readScopeKey := scopeKey(request.ScopeType, scopeID)
	updatedAt := model.GetMillis()

	previousState, err := store.GetReadState(request.ScopeType, scopeID, userID)
	if err != nil {
		return nil, newHTTPError(http.StatusInternalServerError, "failed to load read state")
	}

	previousPostID := ""
	previousIndexedPostID := ""
	previousMirrorEmojiName := ""
	if previousState != nil {
		previousPostID = previousState.LastReadPostID
		previousIndexedPostID = previousState.IndexedPostID
		previousMirrorEmojiName = previousState.MirrorEmojiName
	}

	indexedPostID := request.LastReadPostID
	if post.UserId == userID {
		indexedPostID = ""
	}

	mirrorEmojiName := ""
	mirrorReactionResult := "disabled"
	if p.shouldManageMirrorReactions(configuration) {
		status := p.resolveMirrorEmojiStatus(configuration)
		if status.EffectiveAvailable {
			mirrorEmojiName = status.EffectiveEmojiName
		} else {
			mirrorReactionResult = "skipped_missing_emoji"
		}
	}

	if previousState != nil && previousState.LastReadPostID == request.LastReadPostID && previousIndexedPostID == indexedPostID && previousMirrorEmojiName == mirrorEmojiName {
		return &readStateResult{
			UserID:          userID,
			ScopeType:       request.ScopeType,
			ScopeID:         scopeID,
			ChannelID:       request.ChannelID,
			PostID:          request.LastReadPostID,
			PreviousPostID:  previousPostID,
			UpdatedAt:       previousState.UpdatedAt,
			MirrorReaction:  "unchanged",
			MirrorEmojiName: mirrorEmojiName,
			Changed:         false,
		}, nil
	}

	if previousIndexedPostID != "" && previousIndexedPostID != indexedPostID {
		if err := store.RemovePostReaderScope(previousIndexedPostID, userID, readScopeKey, updatedAt); err != nil {
			return nil, newHTTPError(http.StatusInternalServerError, "failed to remove previous reader index")
		}
	}

	if indexedPostID != "" {
		scope := ReaderScopeRecord{
			ScopeType: request.ScopeType,
			ScopeID:   scopeID,
			ChannelID: request.ChannelID,
			ThreadID:  request.ThreadID,
		}
		if err := store.UpsertPostReaderScope(indexedPostID, request.ChannelID, userID, scope, updatedAt); err != nil {
			return nil, newHTTPError(http.StatusInternalServerError, "failed to update reader index")
		}
	}

	state := &ReadStateRecord{
		Version:         storageVersion,
		ScopeType:       request.ScopeType,
		ScopeID:         scopeID,
		ChannelID:       request.ChannelID,
		ThreadID:        request.ThreadID,
		UserID:          userID,
		LastReadPostID:  request.LastReadPostID,
		IndexedPostID:   indexedPostID,
		PreviousPostID:  previousPostID,
		MirrorEmojiName: mirrorEmojiName,
		UpdatedAt:       updatedAt,
		Metadata: map[string]any{
			"source": "server_http_api",
		},
	}

	if err := store.SaveReadState(state); err != nil {
		return nil, newHTTPError(http.StatusInternalServerError, "failed to save read state")
	}

	if p.shouldManageMirrorReactions(configuration) {
		mirrorReactionResult = p.applyMirrorReactionMove(userID, request.ChannelID, previousIndexedPostID, indexedPostID, previousMirrorEmojiName, mirrorEmojiName)
	}

	result := &readStateResult{
		UserID:          userID,
		ScopeType:       request.ScopeType,
		ScopeID:         scopeID,
		ChannelID:       request.ChannelID,
		PostID:          request.LastReadPostID,
		PreviousPostID:  previousPostID,
		UpdatedAt:       updatedAt,
		MirrorReaction:  mirrorReactionResult,
		MirrorEmojiName: mirrorEmojiName,
		Changed:         true,
	}

	if result.Changed {
		p.publishReadReceiptUpdated(result)
	}

	return result, nil
}
