package main

import (
	"bytes"
	"sort"
	"sync"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/require"
)

type memoryKV struct {
	lock                  sync.Mutex
	data                  map[string][]byte
	setCount              int
	compareAndSetCount    int
	compareAndDeleteCount int
	deleteCount           int
}

func newMemoryKV() *memoryKV {
	return &memoryKV{data: make(map[string][]byte)}
}

func (m *memoryKV) KVGet(key string) ([]byte, *model.AppError) {
	m.lock.Lock()
	defer m.lock.Unlock()

	return cloneBytes(m.data[key]), nil
}

func (m *memoryKV) KVSet(key string, value []byte) *model.AppError {
	m.lock.Lock()
	defer m.lock.Unlock()

	m.setCount++
	m.data[key] = cloneBytes(value)
	return nil
}

func (m *memoryKV) KVCompareAndSet(key string, oldValue, newValue []byte) (bool, *model.AppError) {
	m.lock.Lock()
	defer m.lock.Unlock()

	current := m.data[key]
	if !bytes.Equal(current, oldValue) {
		return false, nil
	}
	m.compareAndSetCount++
	m.data[key] = cloneBytes(newValue)
	return true, nil
}

func (m *memoryKV) KVCompareAndDelete(key string, oldValue []byte) (bool, *model.AppError) {
	m.lock.Lock()
	defer m.lock.Unlock()

	current := m.data[key]
	if !bytes.Equal(current, oldValue) {
		return false, nil
	}
	m.compareAndDeleteCount++
	delete(m.data, key)
	return true, nil
}

func (m *memoryKV) KVDelete(key string) *model.AppError {
	m.lock.Lock()
	defer m.lock.Unlock()

	m.deleteCount++
	delete(m.data, key)
	return nil
}

func (m *memoryKV) KVList(page, perPage int) ([]string, *model.AppError) {
	m.lock.Lock()
	defer m.lock.Unlock()

	keys := make([]string, 0, len(m.data))
	for key := range m.data {
		keys = append(keys, key)
	}
	sort.Strings(keys)

	start := page * perPage
	if start >= len(keys) {
		return nil, nil
	}
	end := start + perPage
	if end > len(keys) {
		end = len(keys)
	}

	return keys[start:end], nil
}

func (m *memoryKV) writeCount() int {
	m.lock.Lock()
	defer m.lock.Unlock()

	return m.setCount + m.compareAndSetCount + m.compareAndDeleteCount + m.deleteCount
}

func TestKVStoreReadStateAndPostReaderMove(t *testing.T) {
	store := NewKVStore(newMemoryKV())
	userID := model.NewId()
	channelID := model.NewId()
	postID1 := model.NewId()
	postID2 := model.NewId()
	scopeID := channelID
	readScopeKey := scopeKey(ScopeTypeChannel, scopeID)
	now := model.GetMillis()

	state := &ReadStateRecord{
		ScopeType:      ScopeTypeChannel,
		ScopeID:        scopeID,
		ChannelID:      channelID,
		UserID:         userID,
		LastReadPostID: postID1,
		IndexedPostID:  postID1,
		UpdatedAt:      now,
	}
	require.NoError(t, store.SaveReadState(state))

	loadedState, err := store.GetReadState(ScopeTypeChannel, scopeID, userID)
	require.NoError(t, err)
	require.Equal(t, postID1, loadedState.LastReadPostID)

	require.NoError(t, store.UpsertPostReaderScope(postID1, channelID, userID, ReaderScopeRecord{
		ScopeType: ScopeTypeChannel,
		ScopeID:   scopeID,
		ChannelID: channelID,
	}, now))

	index1, err := store.GetPostReaders(postID1)
	require.NoError(t, err)
	require.Contains(t, index1.Readers, userID)

	require.NoError(t, store.RemovePostReaderScope(postID1, userID, readScopeKey, now+1))
	index1, err = store.GetPostReaders(postID1)
	require.NoError(t, err)
	require.NotContains(t, index1.Readers, userID)

	require.NoError(t, store.UpsertPostReaderScope(postID2, channelID, userID, ReaderScopeRecord{
		ScopeType: ScopeTypeChannel,
		ScopeID:   scopeID,
		ChannelID: channelID,
	}, now+2))
	index2, err := store.GetPostReaders(postID2)
	require.NoError(t, err)
	require.Contains(t, index2.Readers, userID)
}

func TestKVStoreCleanupExpiredReadReceipts(t *testing.T) {
	kv := newMemoryKV()
	store := NewKVStore(kv)
	channelID := model.NewId()
	oldPostID := model.NewId()
	newPostID := model.NewId()
	oldUserID := model.NewId()
	newUserID := model.NewId()
	now := model.GetMillis()
	oldUpdatedAt := now - int64(31*24*60*60*1000)

	record := &ReadStateRecord{
		ScopeType:      ScopeTypeChannel,
		ScopeID:        channelID,
		ChannelID:      channelID,
		UserID:         oldUserID,
		LastReadPostID: oldPostID,
		IndexedPostID:  oldPostID,
		UpdatedAt:      oldUpdatedAt,
	}
	require.NoError(t, store.SaveReadState(record))
	require.NoError(t, store.UpsertPostReaderScope(oldPostID, channelID, oldUserID, ReaderScopeRecord{
		ScopeType: ScopeTypeChannel,
		ScopeID:   channelID,
		ChannelID: channelID,
	}, oldUpdatedAt))
	require.NoError(t, store.UpsertPostReaderScope(newPostID, channelID, newUserID, ReaderScopeRecord{
		ScopeType: ScopeTypeChannel,
		ScopeID:   channelID,
		ChannelID: channelID,
	}, now))

	stats, err := store.CleanupExpiredReadReceipts(30, now)
	require.NoError(t, err)
	require.Equal(t, 1, stats.DeletedStateRecords)
	require.Equal(t, 1, stats.DeletedPostIndexes)
	require.Equal(t, 1, stats.PrunedReaderRecords)

	state, err := store.GetReadState(ScopeTypeChannel, channelID, oldUserID)
	require.NoError(t, err)
	require.Nil(t, state)

	oldIndex, err := store.GetPostReaders(oldPostID)
	require.NoError(t, err)
	require.Empty(t, oldIndex.Readers)

	newIndex, err := store.GetPostReaders(newPostID)
	require.NoError(t, err)
	require.Contains(t, newIndex.Readers, newUserID)
}
