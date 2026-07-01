package main

import (
	"testing"

	"github.com/mattermost/mattermost/server/public/model"
	"github.com/mattermost/mattermost/server/public/plugin/plugintest"
	"github.com/stretchr/testify/mock"
	"github.com/stretchr/testify/require"
)

func TestOnActivateReloadsPersistedConfiguration(t *testing.T) {
	api := &plugintest.API{}
	p := &Plugin{}
	p.API = api

	staleConfiguration := defaultConfiguration()
	staleConfiguration.ReadReceiptMode = ModeLegacyReactions
	p.setConfiguration(staleConfiguration)

	api.On("GetPluginConfig").Return(map[string]any{
		"readReceiptMode": string(ModeLegacyReactions),
		"readreceiptmode": string(ModeHybridServer),
		"showReaderNames": false,
	}).Once()

	require.NoError(t, p.OnActivate())

	configuration := p.getConfiguration()
	require.NotNil(t, configuration)
	require.Equal(t, ModeHybridServer, configuration.ReadReceiptMode)
	require.False(t, configuration.ShowReaderNames)

	api.AssertExpectations(t)
}

func TestOnConfigurationChangeMarksDirtyAndPublishesWithoutConfigAPI(t *testing.T) {
	api := &plugintest.API{}
	p := &Plugin{}
	p.API = api

	cachedConfiguration := defaultConfiguration()
	cachedConfiguration.ReadReceiptMode = ModeServerWebOnly
	p.setConfiguration(cachedConfiguration)

	api.On("PublishWebSocketEvent", websocketEventReadReceiptConfigChanged, mock.MatchedBy(func(payload map[string]any) bool {
		_, hasConfig := payload["config"]
		return !hasConfig && payload["updated_at"] != nil
	}), mock.MatchedBy(func(broadcast *model.WebsocketBroadcast) bool {
		return broadcast != nil
	})).Return().Once()

	require.NoError(t, p.OnConfigurationChange())
	require.True(t, p.isConfigurationDirty())

	api.AssertNumberOfCalls(t, "GetConfig", 0)
	api.AssertNumberOfCalls(t, "GetPluginConfig", 0)
	api.AssertNumberOfCalls(t, "GetUnsanitizedConfig", 0)
	api.AssertNumberOfCalls(t, "LoadPluginConfiguration", 0)
	api.AssertExpectations(t)
}

func TestOnActivateFallsBackWhenPersistedConfigurationIsInvalid(t *testing.T) {
	api := &plugintest.API{}
	p := &Plugin{}
	p.API = api

	api.On("GetPluginConfig").Return(map[string]any{
		"readReceiptMode": "invalid",
	}).Once()
	api.On("LogError", "failed to load plugin configuration; using fallback", "error", mock.Anything).Return().Once()

	require.NoError(t, p.OnActivate())

	configuration := p.getConfiguration()
	require.NotNil(t, configuration)
	require.Equal(t, ModeLegacyReactions, configuration.ReadReceiptMode)
	require.False(t, p.isConfigurationDirty())

	api.AssertExpectations(t)
}
