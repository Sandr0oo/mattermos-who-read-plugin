package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func TestServeHTTPReadStateHappyPath(t *testing.T) {
	api := &plugintest.API{}
	plugin := &Plugin{}
	plugin.API = api
	attachMockKV(api)
	plugin.store = NewKVStore(api)
	configuration := defaultConfiguration()
	configuration.ReadReceiptMode = ModeServerWebOnly
	configuration.MirrorReactionsEnabled = false
	plugin.setConfiguration(configuration)

	userID := model.NewId()
	otherUserID := model.NewId()
	channelID := model.NewId()
	postID := model.NewId()

	api.On("GetChannelMember", channelID, userID).Return(&model.ChannelMember{ChannelId: channelID, UserId: userID}, nil).Once()
	api.On("GetPost", postID).Return(&model.Post{Id: postID, ChannelId: channelID, UserId: otherUserID}, nil).Once()
	api.On("PublishWebSocketEvent", websocketEventReadReceiptUpdated, mock.Anything, mock.MatchedBy(func(broadcast *model.WebsocketBroadcast) bool {
		return broadcast != nil && broadcast.ChannelId == channelID
	})).Return().Once()

	body := map[string]any{
		"scope_type":        ScopeTypeChannel,
		"channel_id":        channelID,
		"last_read_post_id": postID,
	}
	request := newJSONRequest(t, http.MethodPost, "/api/v1/read-state", body)
	request.Header.Set(mattermostUserIDHeader, userID)
	response := httptest.NewRecorder()

	plugin.ServeHTTP(nil, response, request)
	require.Equal(t, http.StatusOK, response.Code)

	var payload map[string]any
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Equal(t, "ok", payload["status"])

	state, err := plugin.store.GetReadState(ScopeTypeChannel, channelID, userID)
	require.NoError(t, err)
	require.Equal(t, postID, state.LastReadPostID)
	require.Equal(t, postID, state.IndexedPostID)

	index, err := plugin.store.GetPostReaders(postID)
	require.NoError(t, err)
	require.Contains(t, index.Readers, userID)
	api.AssertExpectations(t)
}

func TestServeHTTPReadStateRequiresAuth(t *testing.T) {
	plugin := &Plugin{}
	request := newJSONRequest(t, http.MethodPost, "/api/v1/read-state", map[string]any{})
	response := httptest.NewRecorder()

	plugin.ServeHTTP(nil, response, request)
	require.Equal(t, http.StatusUnauthorized, response.Code)
}

func TestServeHTTPReadStateSuppressesNoop(t *testing.T) {
	api := &plugintest.API{}
	plugin := &Plugin{}
	plugin.API = api
	kv := attachMockKV(api)
	plugin.store = NewKVStore(api)
	configuration := defaultConfiguration()
	configuration.ReadReceiptMode = ModeServerWebOnly
	configuration.MirrorReactionsEnabled = false
	plugin.setConfiguration(configuration)

	userID := model.NewId()
	otherUserID := model.NewId()
	channelID := model.NewId()
	postID := model.NewId()
	body := map[string]any{
		"scope_type":        ScopeTypeChannel,
		"channel_id":        channelID,
		"last_read_post_id": postID,
	}

	api.On("GetChannelMember", channelID, userID).Return(&model.ChannelMember{ChannelId: channelID, UserId: userID}, nil).Twice()
	api.On("GetPost", postID).Return(&model.Post{Id: postID, ChannelId: channelID, UserId: otherUserID}, nil).Twice()
	api.On("PublishWebSocketEvent", websocketEventReadReceiptUpdated, mock.Anything, mock.Anything).Return().Once()

	request := newJSONRequest(t, http.MethodPost, "/api/v1/read-state", body)
	request.Header.Set(mattermostUserIDHeader, userID)
	response := httptest.NewRecorder()
	plugin.ServeHTTP(nil, response, request)
	require.Equal(t, http.StatusOK, response.Code)
	writesAfterFirstMark := kv.writeCount()

	request = newJSONRequest(t, http.MethodPost, "/api/v1/read-state", body)
	request.Header.Set(mattermostUserIDHeader, userID)
	response = httptest.NewRecorder()
	plugin.ServeHTTP(nil, response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.Equal(t, writesAfterFirstMark, kv.writeCount())

	var payload struct {
		Data readStateResult `json:"data"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.False(t, payload.Data.Changed)
	require.Equal(t, "unchanged", payload.Data.MirrorReaction)

	api.AssertExpectations(t)
}

func TestServeHTTPReadersBatchHidesReadersWhenNamesDisabled(t *testing.T) {
	api := &plugintest.API{}
	plugin := &Plugin{}
	plugin.API = api
	plugin.store = NewKVStore(newMemoryKV())
	configuration := defaultConfiguration()
	configuration.ShowReaderNames = false
	plugin.setConfiguration(configuration)

	requestUserID := model.NewId()
	readerUserID := model.NewId()
	channelID := model.NewId()
	postID := model.NewId()
	now := model.GetMillis()

	require.NoError(t, plugin.store.UpsertPostReaderScope(postID, channelID, readerUserID, ReaderScopeRecord{
		ScopeType: ScopeTypeChannel,
		ScopeID:   channelID,
		ChannelID: channelID,
	}, now))

	api.On("GetPost", postID).Return(&model.Post{Id: postID, ChannelId: channelID, UserId: model.NewId()}, nil).Once()
	api.On("GetChannelMember", channelID, requestUserID).Return(&model.ChannelMember{ChannelId: channelID, UserId: requestUserID}, nil).Once()

	request := newJSONRequest(t, http.MethodPost, "/api/v1/readers/batch", map[string]any{"post_ids": []string{postID}})
	request.Header.Set(mattermostUserIDHeader, requestUserID)
	response := httptest.NewRecorder()

	plugin.ServeHTTP(nil, response, request)
	require.Equal(t, http.StatusOK, response.Code)
	require.NotContains(t, response.Body.String(), "user_id")
	require.NotContains(t, response.Body.String(), readerUserID)

	var payload struct {
		Posts map[string]struct {
			Count   int              `json:"count"`
			Readers []map[string]any `json:"readers"`
		} `json:"posts"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Contains(t, payload.Posts, postID)
	require.Equal(t, 1, payload.Posts[postID].Count)
	require.Empty(t, payload.Posts[postID].Readers)

	api.AssertExpectations(t)
}

func TestServeHTTPAdminCleanupRetention(t *testing.T) {
	api := &plugintest.API{}
	plugin := &Plugin{}
	plugin.API = api
	attachMockKV(api)
	plugin.store = NewKVStore(api)
	configuration := defaultConfiguration()
	configuration.RetentionDays = 30
	plugin.setConfiguration(configuration)

	adminID := model.NewId()
	readerID := model.NewId()
	channelID := model.NewId()
	postID := model.NewId()
	oldUpdatedAt := model.GetMillis() - int64(31*24*60*60*1000)
	require.NoError(t, plugin.store.UpsertPostReaderScope(postID, channelID, readerID, ReaderScopeRecord{
		ScopeType: ScopeTypeChannel,
		ScopeID:   channelID,
		ChannelID: channelID,
	}, oldUpdatedAt))

	api.On("HasPermissionTo", adminID, model.PermissionManageSystem).Return(true).Once()

	request := newJSONRequest(t, http.MethodPost, "/api/v1/admin/cleanup-retention", map[string]any{})
	request.Header.Set(mattermostUserIDHeader, adminID)
	response := httptest.NewRecorder()

	plugin.ServeHTTP(nil, response, request)
	require.Equal(t, http.StatusOK, response.Code)

	var payload cleanupRetentionResponse
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &payload))
	require.Equal(t, "ok", payload.Status)
	require.NotNil(t, payload.Stats)
	require.Equal(t, 1, payload.Stats.DeletedPostIndexes)
	require.Equal(t, 1, payload.Stats.PrunedReaderRecords)

	index, err := plugin.store.GetPostReaders(postID)
	require.NoError(t, err)
	require.Empty(t, index.Readers)
	api.AssertExpectations(t)
}

func newJSONRequest(t *testing.T, method, path string, body any) *http.Request {
	t.Helper()

	encoded, err := json.Marshal(body)
	require.NoError(t, err)

	request := httptest.NewRequest(method, path, bytes.NewReader(encoded))
	request.Header.Set("Content-Type", "application/json")
	return request
}

func attachMockKV(api *plugintest.API) *memoryKV {
	kv := newMemoryKV()
	api.On("KVGet", mock.AnythingOfType("string")).Return(func(key string) []byte {
		value, _ := kv.KVGet(key)
		return value
	}, func(key string) *model.AppError {
		_, appErr := kv.KVGet(key)
		return appErr
	})
	api.On("KVSet", mock.AnythingOfType("string"), mock.Anything).Return(func(key string, value []byte) *model.AppError {
		return kv.KVSet(key, value)
	}).Maybe()
	api.On("KVCompareAndSet", mock.AnythingOfType("string"), mock.Anything, mock.Anything).Return(func(key string, oldValue, newValue []byte) (bool, *model.AppError) {
		return kv.KVCompareAndSet(key, oldValue, newValue)
	})
	api.On("KVCompareAndDelete", mock.AnythingOfType("string"), mock.Anything).Return(func(key string, oldValue []byte) (bool, *model.AppError) {
		return kv.KVCompareAndDelete(key, oldValue)
	}).Maybe()
	api.On("KVDelete", mock.AnythingOfType("string")).Return(func(key string) *model.AppError {
		return kv.KVDelete(key)
	}).Maybe()
	api.On("KVList", mock.AnythingOfType("int"), mock.AnythingOfType("int")).Return(func(page, perPage int) []string {
		keys, _ := kv.KVList(page, perPage)
		return keys
	}, func(page, perPage int) *model.AppError {
		_, appErr := kv.KVList(page, perPage)
		return appErr
	}).Maybe()

	return kv
}
