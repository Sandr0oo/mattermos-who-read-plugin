package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"path/filepath"
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/stretchr/testify/require"
)

type testPluginConfigAPI struct {
	getPluginConfigCalled bool
}

func (api *testPluginConfigAPI) GetPluginConfig() map[string]any {
	api.getPluginConfigCalled = true
	return map[string]any{
		"readReceiptMode": string(ModeLegacyReactions),
	}
}

func (api *testPluginConfigAPI) LoadPluginConfiguration(_ any) error {
	return nil
}

func TestLoadConfigurationDefaults(t *testing.T) {
	configuration, err := loadConfiguration(nil)
	require.NoError(t, err)
	require.Equal(t, ModeLegacyReactions, configuration.ReadReceiptMode)
	require.Equal(t, defaultMirrorEmojiName, configuration.MirrorEmojiName)
	require.True(t, configuration.MirrorReactionsEnabled)
	require.True(t, configuration.HideMirrorReactionsInWeb)
	require.False(t, configuration.FallbackToStandardEyes)
	require.True(t, configuration.ShowReaderNames)
	require.Equal(t, defaultRetentionDays, configuration.RetentionDays)
	require.Equal(t, defaultMaxReadersPerPost, configuration.MaxReadersPerPost)
}

func TestLoadConfigurationPrefersLocalModePersistedConfiguration(t *testing.T) {
	listener, err := net.Listen("unix", filepath.Join(t.TempDir(), "mattermost_local.socket"))
	require.NoError(t, err)

	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v4/config" {
			http.NotFound(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(&model.Config{
			PluginSettings: model.PluginSettings{
				Plugins: map[string]map[string]any{
					manifest.Id: {
						"readReceiptMode": string(ModeLegacyReactions),
						"readreceiptmode": string(ModeHybridServer),
					},
				},
			},
		})
	})}
	go func() {
		_ = server.Serve(listener)
	}()
	t.Cleanup(func() {
		require.NoError(t, server.Shutdown(context.Background()))
	})

	originalSocketPath := localModeSocketPath
	localModeSocketPath = listener.Addr().String()
	t.Cleanup(func() {
		localModeSocketPath = originalSocketPath
	})

	api := &testPluginConfigAPI{}
	configuration, err := loadConfiguration(api)
	require.NoError(t, err)
	require.Equal(t, ModeHybridServer, configuration.ReadReceiptMode)
	require.False(t, api.getPluginConfigCalled)
}

func TestApplyRawConfigurationAcceptsCamelCaseKeys(t *testing.T) {
	configuration := defaultConfiguration()

	require.NoError(t, applyRawConfiguration(configuration, map[string]any{
		"readReceiptMode":          string(ModeHybridServer),
		"mirrorEmojiName":          "custom_eyes",
		"mirrorReactionsEnabled":   false,
		"hideMirrorReactionsInWeb": false,
		"fallbackToStandardEyes":   true,
		"showReaderNames":          false,
		"retentionDays":            30,
		"maxReadersPerPost":        20,
	}))

	require.Equal(t, ModeHybridServer, configuration.ReadReceiptMode)
	require.Equal(t, "custom_eyes", configuration.MirrorEmojiName)
	require.False(t, configuration.MirrorReactionsEnabled)
	require.False(t, configuration.HideMirrorReactionsInWeb)
	require.True(t, configuration.FallbackToStandardEyes)
	require.False(t, configuration.ShowReaderNames)
	require.Equal(t, 30, configuration.RetentionDays)
	require.Equal(t, 20, configuration.MaxReadersPerPost)
}

func TestApplyRawConfigurationAcceptsLowercaseKeys(t *testing.T) {
	configuration := defaultConfiguration()

	require.NoError(t, applyRawConfiguration(configuration, map[string]any{
		"readreceiptmode":          string(ModeServerWebOnly),
		"mirroremojiname":          "lower_eyes",
		"mirrorreactionsenabled":   false,
		"hidemirrorreactionsinweb": false,
		"fallbacktostandardeyes":   true,
		"showreadernames":          false,
		"retentiondays":            14,
		"maxreadersperpost":        25,
	}))

	require.Equal(t, ModeServerWebOnly, configuration.ReadReceiptMode)
	require.Equal(t, "lower_eyes", configuration.MirrorEmojiName)
	require.False(t, configuration.MirrorReactionsEnabled)
	require.False(t, configuration.HideMirrorReactionsInWeb)
	require.True(t, configuration.FallbackToStandardEyes)
	require.False(t, configuration.ShowReaderNames)
	require.Equal(t, 14, configuration.RetentionDays)
	require.Equal(t, 25, configuration.MaxReadersPerPost)
}

func TestApplyRawConfigurationLowercaseOverridesCamelCaseKeys(t *testing.T) {
	configuration := defaultConfiguration()

	require.NoError(t, applyRawConfiguration(configuration, map[string]any{
		"readReceiptMode":          string(ModeLegacyReactions),
		"readreceiptmode":          string(ModeHybridServer),
		"mirrorEmojiName":          "stale_eyes",
		"mirroremojiname":          "fresh_eyes",
		"mirrorReactionsEnabled":   true,
		"mirrorreactionsenabled":   false,
		"hideMirrorReactionsInWeb": true,
		"hidemirrorreactionsinweb": false,
		"fallbackToStandardEyes":   false,
		"fallbacktostandardeyes":   true,
		"showReaderNames":          true,
		"showreadernames":          false,
		"retentionDays":            30,
		"retentiondays":            7,
		"maxReadersPerPost":        40,
		"maxreadersperpost":        8,
	}))

	require.Equal(t, ModeHybridServer, configuration.ReadReceiptMode)
	require.Equal(t, "fresh_eyes", configuration.MirrorEmojiName)
	require.False(t, configuration.MirrorReactionsEnabled)
	require.False(t, configuration.HideMirrorReactionsInWeb)
	require.True(t, configuration.FallbackToStandardEyes)
	require.False(t, configuration.ShowReaderNames)
	require.Equal(t, 7, configuration.RetentionDays)
	require.Equal(t, 8, configuration.MaxReadersPerPost)
}

func TestApplyRawConfigurationLowercaseTypeErrorUsesCanonicalKey(t *testing.T) {
	configuration := defaultConfiguration()

	err := applyRawConfiguration(configuration, map[string]any{
		"readreceiptmode": 123,
	})

	require.EqualError(t, err, "configuration readReceiptMode must be a string")
}

func TestNormalizeConfiguration(t *testing.T) {
	configuration := defaultConfiguration()
	configuration.ReadReceiptMode = ReadReceiptMode(legacyModeAlias)
	configuration.MirrorEmojiName = ":custom_eyes:"
	configuration.RetentionDays = maximumRetentionDays + 1
	configuration.MaxReadersPerPost = maximumMaxReadersPerPost + 1

	require.NoError(t, normalizeConfiguration(configuration))
	require.Equal(t, ModeLegacyReactions, configuration.ReadReceiptMode)
	require.Equal(t, "custom_eyes", configuration.MirrorEmojiName)
	require.Equal(t, maximumRetentionDays, configuration.RetentionDays)
	require.Equal(t, maximumMaxReadersPerPost, configuration.MaxReadersPerPost)
}

func TestNormalizeConfigurationRejectsInvalidMode(t *testing.T) {
	configuration := defaultConfiguration()
	configuration.ReadReceiptMode = "invalid"

	require.ErrorContains(t, normalizeConfiguration(configuration), "invalid readReceiptMode")
}
