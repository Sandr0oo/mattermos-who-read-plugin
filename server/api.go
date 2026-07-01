package main

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin"
)

const (
	apiV1Prefix     = "/api/v1"
	maxJSONBodySize = 1 << 20
	maxBatchPostIDs = 100
)

type readersBatchRequest struct {
	PostIDs []string `json:"post_ids"`
}

type cleanupRetentionResponse struct {
	Status string        `json:"status"`
	Stats  *CleanupStats `json:"stats"`
}

type readerInfo struct {
	UserID    string `json:"user_id"`
	Username  string `json:"username,omitempty"`
	FirstName string `json:"first_name,omitempty"`
	LastName  string `json:"last_name,omitempty"`
	Nickname  string `json:"nickname,omitempty"`
	UpdatedAt int64  `json:"updated_at"`
}

type postReadersResponse struct {
	PostID  string       `json:"post_id"`
	Count   int          `json:"count"`
	Readers []readerInfo `json:"readers"`
}

func (p *Plugin) ServeHTTP(_ *plugin.Context, w http.ResponseWriter, r *http.Request) {
	path := apiPath(r.URL.Path)
	if path == "" {
		writeError(w, http.StatusNotFound, "not found")
		return
	}

	switch {
	case r.Method == http.MethodGet && path == "/config":
		p.handleGetConfig(w, r)
	case r.Method == http.MethodGet && path == "/emoji/status":
		p.handleGetEmojiStatus(w, r)
	case r.Method == http.MethodPost && path == "/read-state":
		p.handlePostReadState(w, r)
	case r.Method == http.MethodPost && path == "/readers/batch":
		p.handlePostReadersBatch(w, r)
	case r.Method == http.MethodPost && path == "/admin/cleanup-retention":
		p.handlePostAdminCleanupRetention(w, r)
	default:
		writeError(w, http.StatusNotFound, "not found")
	}
}

func (p *Plugin) handleGetConfig(w http.ResponseWriter, _ *http.Request) {
	configuration := p.getFreshConfiguration()
	writeJSON(w, http.StatusOK, configuration)
}

func (p *Plugin) handleGetEmojiStatus(w http.ResponseWriter, _ *http.Request) {
	configuration := p.getConfiguration()
	if configuration == nil {
		configuration = defaultConfiguration()
	}

	writeJSON(w, http.StatusOK, p.resolveMirrorEmojiStatus(configuration))
}

func (p *Plugin) handlePostReadState(w http.ResponseWriter, r *http.Request) {
	userID, httpErr := authenticatedUserID(r)
	if httpErr != nil {
		writeHTTPError(w, httpErr)
		return
	}

	var request readStateRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	post, httpErr := p.validateReadStateRequest(userID, request)
	if httpErr != nil {
		writeHTTPError(w, httpErr)
		return
	}

	result, httpErr := p.markReadState(userID, request, post)
	if httpErr != nil {
		writeHTTPError(w, httpErr)
		return
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"status": "ok",
		"data":   result,
	})
}

func (p *Plugin) handlePostReadersBatch(w http.ResponseWriter, r *http.Request) {
	userID, httpErr := authenticatedUserID(r)
	if httpErr != nil {
		writeHTTPError(w, httpErr)
		return
	}

	var request readersBatchRequest
	if err := decodeJSONBody(r, &request); err != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
		return
	}

	postIDs := uniquePostIDs(request.PostIDs)
	if len(postIDs) == 0 {
		writeError(w, http.StatusBadRequest, "post_ids is required")
		return
	}
	if len(postIDs) > maxBatchPostIDs {
		writeError(w, http.StatusBadRequest, "too many post_ids")
		return
	}
	for _, postID := range postIDs {
		if httpErr := validateID("post_id", postID); httpErr != nil {
			writeHTTPError(w, httpErr)
			return
		}
	}

	store := p.getStore()
	if store == nil {
		writeError(w, http.StatusInternalServerError, "storage is not initialized")
		return
	}

	configuration := p.getConfiguration()
	if configuration == nil {
		configuration = defaultConfiguration()
	}

	posts := make(map[string]postReadersResponse, len(postIDs))
	now := model.GetMillis()
	for _, postID := range postIDs {
		index, err := store.GetPostReaders(postID)
		if err != nil {
			writeError(w, http.StatusInternalServerError, "failed to load readers")
			return
		}

		channelID := ""
		if index != nil {
			channelID = index.ChannelID
		}
		if channelID == "" {
			post, getPostErr := p.getPost(postID)
			if getPostErr != nil {
				continue
			}
			channelID = post.ChannelId
		}
		if memberErr := p.ensureChannelMember(userID, channelID); memberErr != nil {
			continue
		}

		snapshots := buildReaderSnapshots(index, configuration.RetentionDays, now)
		readers := make([]readerInfo, 0)
		if configuration.ShowReaderNames {
			readers = make([]readerInfo, 0, minInt(len(snapshots), configuration.MaxReadersPerPost))
			for _, snapshot := range snapshots {
				if len(readers) >= configuration.MaxReadersPerPost {
					break
				}
				readers = append(readers, p.readerInfo(snapshot, true))
			}
		}

		posts[postID] = postReadersResponse{
			PostID:  postID,
			Count:   len(snapshots),
			Readers: readers,
		}
	}

	writeJSON(w, http.StatusOK, map[string]any{
		"posts":                posts,
		"max_readers_per_post": configuration.MaxReadersPerPost,
	})
}

func (p *Plugin) handlePostAdminCleanupRetention(w http.ResponseWriter, r *http.Request) {
	userID, httpErr := authenticatedUserID(r)
	if httpErr != nil {
		writeHTTPError(w, httpErr)
		return
	}
	if httpErr := p.ensureSystemAdmin(userID); httpErr != nil {
		writeHTTPError(w, httpErr)
		return
	}

	store := p.getStore()
	if store == nil {
		writeError(w, http.StatusInternalServerError, "storage is not initialized")
		return
	}

	configuration := p.getConfiguration()
	if configuration == nil {
		configuration = defaultConfiguration()
	}

	stats, err := store.CleanupExpiredReadReceipts(configuration.RetentionDays, model.GetMillis())
	if err != nil {
		writeError(w, http.StatusInternalServerError, "failed to cleanup read receipts")
		return
	}

	writeJSON(w, http.StatusOK, cleanupRetentionResponse{Status: "ok", Stats: stats})
}

func (p *Plugin) readerInfo(snapshot ReaderSnapshot, includeNames bool) readerInfo {
	info := readerInfo{UserID: snapshot.UserID, UpdatedAt: snapshot.UpdatedAt}
	if !includeNames || p.API == nil {
		return info
	}

	user, appErr := p.API.GetUser(snapshot.UserID)
	if appErr != nil || user == nil {
		return info
	}

	info.Username = user.Username
	info.FirstName = user.FirstName
	info.LastName = user.LastName
	info.Nickname = user.Nickname
	return info
}

func apiPath(path string) string {
	if strings.HasPrefix(path, apiV1Prefix) {
		return strings.TrimPrefix(path, apiV1Prefix)
	}
	index := strings.Index(path, apiV1Prefix)
	if index == -1 {
		return ""
	}
	return strings.TrimPrefix(path[index:], apiV1Prefix)
}

func decodeJSONBody(r *http.Request, target any) error {
	defer r.Body.Close()

	reader := io.LimitReader(r.Body, maxJSONBodySize)
	decoder := json.NewDecoder(reader)
	decoder.DisallowUnknownFields()
	return decoder.Decode(target)
}

func writeHTTPError(w http.ResponseWriter, httpErr *httpError) {
	writeError(w, httpErr.StatusCode, httpErr.Message)
}

func writeError(w http.ResponseWriter, statusCode int, message string) {
	writeJSON(w, statusCode, map[string]any{"error": message})
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func uniquePostIDs(postIDs []string) []string {
	seen := make(map[string]bool, len(postIDs))
	unique := make([]string, 0, len(postIDs))
	for _, postID := range postIDs {
		postID = strings.TrimSpace(postID)
		if postID == "" || seen[postID] {
			continue
		}
		seen[postID] = true
		unique = append(unique, postID)
	}
	return unique
}

func minInt(a, b int) int {
	if a < b {
		return a
	}
	return b
}
