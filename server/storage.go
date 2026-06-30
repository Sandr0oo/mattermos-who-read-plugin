package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"sort"
	"strings"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
)

const (
	storageVersion = 1
	kvPrefix       = "rr:v1"
	maxCASAttempts = 5
)

type kvAPI interface {
	KVGet(key string) ([]byte, *model.AppError)
	KVSet(key string, value []byte) *model.AppError
	KVCompareAndSet(key string, oldValue, newValue []byte) (bool, *model.AppError)
	KVCompareAndDelete(key string, oldValue []byte) (bool, *model.AppError)
	KVDelete(key string) *model.AppError
	KVList(page, perPage int) ([]string, *model.AppError)
}

type KVStore struct {
	api kvAPI
}

type ReadStateRecord struct {
	Version         int            `json:"version"`
	ScopeType       ScopeType      `json:"scope_type"`
	ScopeID         string         `json:"scope_id"`
	ChannelID       string         `json:"channel_id"`
	ThreadID        string         `json:"thread_id,omitempty"`
	UserID          string         `json:"user_id"`
	LastReadPostID  string         `json:"last_read_post_id"`
	IndexedPostID   string         `json:"indexed_post_id,omitempty"`
	PreviousPostID  string         `json:"previous_post_id,omitempty"`
	MirrorEmojiName string         `json:"mirror_emoji_name,omitempty"`
	UpdatedAt       int64          `json:"updated_at"`
	Metadata        map[string]any `json:"metadata,omitempty"`
}

type PostReadersIndex struct {
	Version   int                          `json:"version"`
	PostID    string                       `json:"post_id"`
	ChannelID string                       `json:"channel_id"`
	Readers   map[string]*PostReaderRecord `json:"readers"`
	CreatedAt int64                        `json:"created_at"`
	UpdatedAt int64                        `json:"updated_at"`
}

type PostReaderRecord struct {
	UserID      string                        `json:"user_id"`
	Scopes      map[string]*ReaderScopeRecord `json:"scopes"`
	FirstReadAt int64                         `json:"first_read_at"`
	UpdatedAt   int64                         `json:"updated_at"`
}

type ReaderScopeRecord struct {
	ScopeType ScopeType `json:"scope_type"`
	ScopeID   string    `json:"scope_id"`
	ChannelID string    `json:"channel_id"`
	ThreadID  string    `json:"thread_id,omitempty"`
	UpdatedAt int64     `json:"updated_at"`
}

type ReaderSnapshot struct {
	UserID    string `json:"user_id"`
	UpdatedAt int64  `json:"updated_at"`
}

type CleanupStats struct {
	ScannedKeys         int   `json:"scanned_keys"`
	DeletedStateRecords int   `json:"deleted_state_records"`
	DeletedPostIndexes  int   `json:"deleted_post_indexes"`
	PrunedReaderRecords int   `json:"pruned_reader_records"`
	UpdatedPostIndexes  int   `json:"updated_post_indexes"`
	RetentionDays       int   `json:"retention_days"`
	CutoffUpdatedAt     int64 `json:"cutoff_updated_at"`
}

func NewKVStore(api kvAPI) *KVStore {
	return &KVStore{api: api}
}

func stateKey(scopeType ScopeType, scopeID, userID string) string {
	return fmt.Sprintf("%s:state:%s:%s:user:%s", kvPrefix, scopeType, scopeID, userID)
}

func postReadersKey(postID string) string {
	return fmt.Sprintf("%s:post:%s:readers", kvPrefix, postID)
}

func postIDFromPostReadersKey(key string) (string, bool) {
	prefix := kvPrefix + ":post:"
	suffix := ":readers"
	if !strings.HasPrefix(key, prefix) || !strings.HasSuffix(key, suffix) {
		return "", false
	}

	postID := strings.TrimSuffix(strings.TrimPrefix(key, prefix), suffix)
	return postID, postID != ""
}

func isReadStateKey(key string) bool {
	return strings.HasPrefix(key, kvPrefix+":state:")
}

func scopeKey(scopeType ScopeType, scopeID string) string {
	return fmt.Sprintf("%s:%s", scopeType, scopeID)
}

func (s *KVStore) GetReadState(scopeType ScopeType, scopeID, userID string) (*ReadStateRecord, error) {
	if s == nil || s.api == nil {
		return nil, fmt.Errorf("storage API is not initialized")
	}

	value, appErr := s.api.KVGet(stateKey(scopeType, scopeID, userID))
	if appErr != nil {
		return nil, appErr
	}
	if len(value) == 0 {
		return nil, nil
	}

	var record ReadStateRecord
	if err := json.Unmarshal(value, &record); err != nil {
		return nil, err
	}
	if record.Version == 0 {
		record.Version = storageVersion
	}

	return &record, nil
}

func (s *KVStore) SaveReadState(record *ReadStateRecord) error {
	if s == nil || s.api == nil {
		return fmt.Errorf("storage API is not initialized")
	}
	if record == nil {
		return fmt.Errorf("read state record is nil")
	}

	record.Version = storageVersion
	value, err := json.Marshal(record)
	if err != nil {
		return err
	}

	if appErr := s.api.KVSet(stateKey(record.ScopeType, record.ScopeID, record.UserID), value); appErr != nil {
		return appErr
	}

	return nil
}

func (s *KVStore) GetPostReaders(postID string) (*PostReadersIndex, error) {
	if s == nil || s.api == nil {
		return nil, fmt.Errorf("storage API is not initialized")
	}

	value, appErr := s.api.KVGet(postReadersKey(postID))
	if appErr != nil {
		return nil, appErr
	}
	if len(value) == 0 {
		return newPostReadersIndex(postID, "", model.GetMillis()), nil
	}

	index, err := decodePostReadersIndex(postID, value)
	if err != nil {
		return nil, err
	}

	return index, nil
}

func (s *KVStore) UpsertPostReaderScope(postID, channelID, userID string, scope ReaderScopeRecord, updatedAt int64) error {
	return s.mutatePostReaders(postID, func(index *PostReadersIndex) bool {
		if index.ChannelID == "" {
			index.ChannelID = channelID
		}
		if index.Readers == nil {
			index.Readers = make(map[string]*PostReaderRecord)
		}

		reader := index.Readers[userID]
		if reader == nil {
			reader = &PostReaderRecord{
				UserID:      userID,
				Scopes:      make(map[string]*ReaderScopeRecord),
				FirstReadAt: updatedAt,
			}
			index.Readers[userID] = reader
		}
		if reader.Scopes == nil {
			reader.Scopes = make(map[string]*ReaderScopeRecord)
		}

		scope.UpdatedAt = updatedAt
		reader.Scopes[scopeKey(scope.ScopeType, scope.ScopeID)] = &scope
		reader.UpdatedAt = updatedAt
		index.UpdatedAt = updatedAt
		if index.CreatedAt == 0 {
			index.CreatedAt = updatedAt
		}

		return true
	})
}

func (s *KVStore) RemovePostReaderScope(postID, userID, scopeKeyValue string, updatedAt int64) error {
	return s.mutatePostReaders(postID, func(index *PostReadersIndex) bool {
		reader := index.Readers[userID]
		if reader == nil || reader.Scopes == nil {
			return false
		}

		if _, ok := reader.Scopes[scopeKeyValue]; !ok {
			return false
		}

		delete(reader.Scopes, scopeKeyValue)
		if len(reader.Scopes) == 0 {
			delete(index.Readers, userID)
		} else {
			reader.UpdatedAt = latestScopeUpdatedAt(reader.Scopes)
		}

		index.UpdatedAt = updatedAt
		return true
	})
}

func (s *KVStore) CleanupExpiredReadReceipts(retentionDays int, now int64) (*CleanupStats, error) {
	if s == nil || s.api == nil {
		return nil, fmt.Errorf("storage API is not initialized")
	}
	if retentionDays <= 0 {
		return &CleanupStats{RetentionDays: retentionDays}, nil
	}

	cutoff := now - int64(retentionDays)*int64(24*time.Hour/time.Millisecond)
	stats := &CleanupStats{RetentionDays: retentionDays, CutoffUpdatedAt: cutoff}
	keys, err := s.listAllKeys()
	if err != nil {
		return nil, err
	}

	for _, key := range keys {
		if !strings.HasPrefix(key, kvPrefix+":") {
			continue
		}
		stats.ScannedKeys++

		if postID, ok := postIDFromPostReadersKey(key); ok {
			if err := s.cleanupExpiredPostReaders(postID, cutoff, now, stats); err != nil {
				return nil, err
			}
			continue
		}

		if isReadStateKey(key) {
			if err := s.cleanupExpiredReadState(key, cutoff, stats); err != nil {
				return nil, err
			}
		}
	}

	return stats, nil
}

func (s *KVStore) listAllKeys() ([]string, error) {
	const perPage = 200
	var allKeys []string

	for page := 0; ; page++ {
		keys, appErr := s.api.KVList(page, perPage)
		if appErr != nil {
			return nil, appErr
		}
		if len(keys) == 0 {
			return allKeys, nil
		}

		allKeys = append(allKeys, keys...)
		if len(keys) < perPage {
			return allKeys, nil
		}
	}
}

func (s *KVStore) cleanupExpiredPostReaders(postID string, cutoff, now int64, stats *CleanupStats) error {
	return s.mutatePostReaders(postID, func(index *PostReadersIndex) bool {
		removed := 0
		for userID, reader := range index.Readers {
			if reader == nil {
				delete(index.Readers, userID)
				removed++
				continue
			}

			updatedAt := reader.UpdatedAt
			if updatedAt == 0 {
				updatedAt = latestScopeUpdatedAt(reader.Scopes)
			}
			if updatedAt < cutoff {
				delete(index.Readers, userID)
				removed++
			}
		}

		if removed == 0 {
			return false
		}

		stats.PrunedReaderRecords += removed
		if len(index.Readers) == 0 {
			stats.DeletedPostIndexes++
		} else {
			index.UpdatedAt = now
			stats.UpdatedPostIndexes++
		}

		return true
	})
}

func (s *KVStore) cleanupExpiredReadState(key string, cutoff int64, stats *CleanupStats) error {
	value, appErr := s.api.KVGet(key)
	if appErr != nil {
		return appErr
	}
	if len(value) == 0 {
		return nil
	}

	var record ReadStateRecord
	if err := json.Unmarshal(value, &record); err != nil {
		return err
	}
	if record.UpdatedAt >= cutoff {
		return nil
	}

	deleted, appErr := s.api.KVCompareAndDelete(key, cloneBytes(value))
	if appErr != nil {
		return appErr
	}
	if deleted {
		stats.DeletedStateRecords++
	}

	return nil
}

func (s *KVStore) mutatePostReaders(postID string, mutate func(index *PostReadersIndex) bool) error {
	if s == nil || s.api == nil {
		return fmt.Errorf("storage API is not initialized")
	}

	key := postReadersKey(postID)
	for attempt := 0; attempt < maxCASAttempts; attempt++ {
		oldValue, appErr := s.api.KVGet(key)
		if appErr != nil {
			return appErr
		}

		index := newPostReadersIndex(postID, "", model.GetMillis())
		if len(oldValue) > 0 {
			decoded, err := decodePostReadersIndex(postID, oldValue)
			if err != nil {
				return err
			}
			index = decoded
		}

		if !mutate(index) {
			return nil
		}

		oldValueForCAS := cloneBytes(oldValue)
		if len(index.Readers) == 0 {
			if len(oldValue) == 0 {
				return nil
			}
			updated, deleteErr := s.api.KVCompareAndDelete(key, oldValueForCAS)
			if deleteErr != nil {
				return deleteErr
			}
			if updated {
				return nil
			}
			continue
		}

		newValue, err := json.Marshal(index)
		if err != nil {
			return err
		}

		updated, appErr := s.api.KVCompareAndSet(key, oldValueForCAS, newValue)
		if appErr != nil {
			return appErr
		}
		if updated {
			return nil
		}
	}

	return fmt.Errorf("failed to update %s after %d compare-and-set attempts", key, maxCASAttempts)
}

func decodePostReadersIndex(postID string, value []byte) (*PostReadersIndex, error) {
	var index PostReadersIndex
	if err := json.Unmarshal(value, &index); err != nil {
		return nil, err
	}
	if index.Version == 0 {
		index.Version = storageVersion
	}
	if index.PostID == "" {
		index.PostID = postID
	}
	if index.Readers == nil {
		index.Readers = make(map[string]*PostReaderRecord)
	}
	for userID, reader := range index.Readers {
		if reader == nil {
			delete(index.Readers, userID)
			continue
		}
		if reader.UserID == "" {
			reader.UserID = userID
		}
		if reader.Scopes == nil {
			reader.Scopes = make(map[string]*ReaderScopeRecord)
		}
	}

	return &index, nil
}

func newPostReadersIndex(postID, channelID string, now int64) *PostReadersIndex {
	return &PostReadersIndex{
		Version:   storageVersion,
		PostID:    postID,
		ChannelID: channelID,
		Readers:   make(map[string]*PostReaderRecord),
		CreatedAt: now,
		UpdatedAt: now,
	}
}

func buildReaderSnapshots(index *PostReadersIndex, retentionDays int, now int64) []ReaderSnapshot {
	if index == nil || len(index.Readers) == 0 {
		return nil
	}

	cutoff := int64(0)
	if retentionDays > 0 {
		cutoff = now - int64(retentionDays)*int64(24*time.Hour/time.Millisecond)
	}

	readers := make([]ReaderSnapshot, 0, len(index.Readers))
	for userID, reader := range index.Readers {
		if reader == nil {
			continue
		}

		updatedAt := reader.UpdatedAt
		if updatedAt == 0 {
			updatedAt = latestScopeUpdatedAt(reader.Scopes)
		}
		if cutoff > 0 && updatedAt < cutoff {
			continue
		}

		readers = append(readers, ReaderSnapshot{UserID: userID, UpdatedAt: updatedAt})
	}

	sort.Slice(readers, func(i, j int) bool {
		if readers[i].UpdatedAt == readers[j].UpdatedAt {
			return readers[i].UserID < readers[j].UserID
		}
		return readers[i].UpdatedAt > readers[j].UpdatedAt
	})

	return readers
}

func latestScopeUpdatedAt(scopes map[string]*ReaderScopeRecord) int64 {
	var latest int64
	for _, scope := range scopes {
		if scope != nil && scope.UpdatedAt > latest {
			latest = scope.UpdatedAt
		}
	}
	return latest
}

func cloneBytes(value []byte) []byte {
	if value == nil {
		return nil
	}
	return bytes.Clone(value)
}
