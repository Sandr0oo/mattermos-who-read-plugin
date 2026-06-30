package main

import (
	"fmt"
	"net/http"

	"github.com/mattermost/mattermost/server/public/model"
)

const mattermostUserIDHeader = "Mattermost-User-Id"

type httpError struct {
	StatusCode int
	Message    string
}

func newHTTPError(statusCode int, format string, args ...any) *httpError {
	return &httpError{StatusCode: statusCode, Message: fmt.Sprintf(format, args...)}
}

func authenticatedUserID(r *http.Request) (string, *httpError) {
	userID := r.Header.Get(mattermostUserIDHeader)
	if userID == "" {
		return "", newHTTPError(http.StatusUnauthorized, "missing %s header", mattermostUserIDHeader)
	}
	if !model.IsValidId(userID) {
		return "", newHTTPError(http.StatusUnauthorized, "invalid user id")
	}

	return userID, nil
}

func validateID(field, value string) *httpError {
	if !model.IsValidId(value) {
		return newHTTPError(http.StatusBadRequest, "invalid %s", field)
	}
	return nil
}

func (p *Plugin) ensureChannelMember(userID, channelID string) *httpError {
	if p.API == nil {
		return newHTTPError(http.StatusInternalServerError, "plugin API is not initialized")
	}

	member, appErr := p.API.GetChannelMember(channelID, userID)
	if appErr != nil || member == nil {
		return newHTTPError(http.StatusForbidden, "user is not a member of the channel")
	}

	return nil
}

func (p *Plugin) ensureSystemAdmin(userID string) *httpError {
	if p.API == nil {
		return newHTTPError(http.StatusInternalServerError, "plugin API is not initialized")
	}

	if !p.API.HasPermissionTo(userID, model.PermissionManageSystem) {
		return newHTTPError(http.StatusForbidden, "user is not allowed to run admin cleanup")
	}

	return nil
}

func (p *Plugin) getPost(postID string) (*model.Post, *httpError) {
	if p.API == nil {
		return nil, newHTTPError(http.StatusInternalServerError, "plugin API is not initialized")
	}

	post, appErr := p.API.GetPost(postID)
	if appErr != nil || post == nil {
		return nil, newHTTPError(http.StatusNotFound, "post not found")
	}

	return post, nil
}
