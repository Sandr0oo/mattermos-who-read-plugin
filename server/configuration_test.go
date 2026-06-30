package main

import (
	"testing"

	"github.com/stretchr/testify/require"
)

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

	require.Error(t, normalizeConfiguration(configuration))
}
