package main

import (
	"context"
	"fmt"
	"os"
	"regexp"
	"strings"
	"time"

	"github.com/mattermost/mattermost/server/public/model"
)

type ReadReceiptMode string

const (
	ModeLegacyReactions ReadReceiptMode = "legacy_reactions"
	ModeHybridServer    ReadReceiptMode = "hybrid_server"
	ModeServerWebOnly   ReadReceiptMode = "server_web_only"

	legacyModeAlias = "legacy"

	defaultMirrorEmojiName     = "who_read_eyes"
	standardEyesEmojiName      = "eyes"
	defaultRetentionDays       = 90
	defaultMaxReadersPerPost   = 50
	maximumMaxReadersPerPost   = 200
	maximumRetentionDays       = 3650
	maximumMirrorEmojiNameSize = 64
	localModeConfigLoadTimeout = 2 * time.Second
)

var mirrorEmojiNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_+\-]+$`)

var localModeSocketPath = model.LocalModeSocketPath

type configuration struct {
	ReadReceiptMode          ReadReceiptMode `json:"readReceiptMode"`
	MirrorEmojiName          string          `json:"mirrorEmojiName"`
	MirrorReactionsEnabled   bool            `json:"mirrorReactionsEnabled"`
	HideMirrorReactionsInWeb bool            `json:"hideMirrorReactionsInWeb"`
	FallbackToStandardEyes   bool            `json:"fallbackToStandardEyes"`
	ShowReaderNames          bool            `json:"showReaderNames"`
	RetentionDays            int             `json:"retentionDays"`
	MaxReadersPerPost        int             `json:"maxReadersPerPost"`
}

type pluginConfigAPI interface {
	GetPluginConfig() map[string]any
	LoadPluginConfiguration(dest any) error
}

func defaultConfiguration() *configuration {
	return &configuration{
		ReadReceiptMode:          ModeLegacyReactions,
		MirrorEmojiName:          defaultMirrorEmojiName,
		MirrorReactionsEnabled:   true,
		HideMirrorReactionsInWeb: true,
		FallbackToStandardEyes:   false,
		ShowReaderNames:          true,
		RetentionDays:            defaultRetentionDays,
		MaxReadersPerPost:        defaultMaxReadersPerPost,
	}
}

func loadConfiguration(api pluginConfigAPI) (*configuration, error) {
	configuration := defaultConfiguration()
	if api == nil {
		return configuration, nil
	}

	raw, err := loadRawPluginConfiguration(api)
	if err != nil {
		return nil, err
	}

	if err := applyRawConfiguration(configuration, raw); err != nil {
		return nil, err
	}

	if err := normalizeConfiguration(configuration); err != nil {
		return nil, err
	}

	return configuration, nil
}

func loadRawPluginConfiguration(api pluginConfigAPI) (map[string]any, error) {
	// Prefer the local-mode REST config when available: the System Console can
	// persist a fresh lowercase key while plugin-scoped config APIs still expose
	// the old in-memory value for a short-lived/stale plugin runtime.
	if raw, ok := loadRawPluginConfigurationFromLocalMode(); ok {
		return raw, nil
	}

	// GetPluginConfig reads the plugin's persisted settings without going through
	// GetConfig()->PluginSettings.Plugins, which can lag after /api/v4/config/patch
	// in plugin runtime. It also preserves raw key spelling so the plugin can keep
	// deterministic lowercase-over-camelCase precedence; Mattermost's
	// LoadPluginConfiguration lowercases plugin keys before unmarshalling.
	if raw := api.GetPluginConfig(); raw != nil {
		return raw, nil
	}

	var raw map[string]any
	if err := api.LoadPluginConfiguration(&raw); err != nil {
		return nil, err
	}

	return raw, nil
}

func loadRawPluginConfigurationFromLocalMode() (map[string]any, bool) {
	if localModeSocketPath == "" {
		return nil, false
	}

	info, err := os.Stat(localModeSocketPath)
	if err != nil || info.Mode()&os.ModeSocket == 0 {
		return nil, false
	}

	ctx, cancel := context.WithTimeout(context.Background(), localModeConfigLoadTimeout)
	defer cancel()

	config, response, err := model.NewAPIv4SocketClient(localModeSocketPath).GetConfig(ctx)
	if err != nil || response == nil || response.StatusCode >= 400 {
		return nil, false
	}

	raw := rawPluginConfiguration(config)
	if raw == nil {
		return nil, false
	}

	return raw, true
}

func rawPluginConfiguration(config *model.Config) map[string]any {
	if config == nil || manifest == nil || config.PluginSettings.Plugins == nil {
		return nil
	}

	return config.PluginSettings.Plugins[manifest.Id]
}

func (c *configuration) Clone() *configuration {
	if c == nil {
		return nil
	}

	clone := *c
	return &clone
}

func applyRawConfiguration(configuration *configuration, raw map[string]any) error {
	if raw == nil {
		return nil
	}

	if value, ok := rawConfigurationValue(raw, "readReceiptMode"); ok {
		stringValue, err := asString("readReceiptMode", value)
		if err != nil {
			return err
		}
		configuration.ReadReceiptMode = ReadReceiptMode(stringValue)
	}

	if value, ok := rawConfigurationValue(raw, "mirrorEmojiName"); ok {
		stringValue, err := asString("mirrorEmojiName", value)
		if err != nil {
			return err
		}
		configuration.MirrorEmojiName = stringValue
	}

	if value, ok := rawConfigurationValue(raw, "mirrorReactionsEnabled"); ok {
		boolValue, err := asBool("mirrorReactionsEnabled", value)
		if err != nil {
			return err
		}
		configuration.MirrorReactionsEnabled = boolValue
	}

	if value, ok := rawConfigurationValue(raw, "hideMirrorReactionsInWeb"); ok {
		boolValue, err := asBool("hideMirrorReactionsInWeb", value)
		if err != nil {
			return err
		}
		configuration.HideMirrorReactionsInWeb = boolValue
	}

	if value, ok := rawConfigurationValue(raw, "fallbackToStandardEyes"); ok {
		boolValue, err := asBool("fallbackToStandardEyes", value)
		if err != nil {
			return err
		}
		configuration.FallbackToStandardEyes = boolValue
	}

	if value, ok := rawConfigurationValue(raw, "showReaderNames"); ok {
		boolValue, err := asBool("showReaderNames", value)
		if err != nil {
			return err
		}
		configuration.ShowReaderNames = boolValue
	}

	if value, ok := rawConfigurationValue(raw, "retentionDays"); ok {
		intValue, err := asInt("retentionDays", value)
		if err != nil {
			return err
		}
		configuration.RetentionDays = intValue
	}

	if value, ok := rawConfigurationValue(raw, "maxReadersPerPost"); ok {
		intValue, err := asInt("maxReadersPerPost", value)
		if err != nil {
			return err
		}
		configuration.MaxReadersPerPost = intValue
	}

	return nil
}

func rawConfigurationValue(raw map[string]any, key string) (any, bool) {
	lowercaseKey := strings.ToLower(key)
	if value, ok := raw[lowercaseKey]; ok {
		return value, true
	}

	value, ok := raw[key]
	return value, ok
}

func normalizeConfiguration(configuration *configuration) error {
	if configuration == nil {
		return fmt.Errorf("configuration is nil")
	}

	mode := ReadReceiptMode(strings.TrimSpace(string(configuration.ReadReceiptMode)))
	switch mode {
	case "":
		configuration.ReadReceiptMode = ModeLegacyReactions
	case ReadReceiptMode(legacyModeAlias):
		configuration.ReadReceiptMode = ModeLegacyReactions
	case ModeLegacyReactions, ModeHybridServer, ModeServerWebOnly:
		configuration.ReadReceiptMode = mode
	default:
		return fmt.Errorf("invalid readReceiptMode %q", configuration.ReadReceiptMode)
	}

	configuration.MirrorEmojiName = normalizeEmojiName(configuration.MirrorEmojiName)
	if configuration.MirrorEmojiName == "" {
		configuration.MirrorEmojiName = defaultMirrorEmojiName
	}
	if len(configuration.MirrorEmojiName) > maximumMirrorEmojiNameSize || !mirrorEmojiNamePattern.MatchString(configuration.MirrorEmojiName) {
		return fmt.Errorf("invalid mirrorEmojiName %q", configuration.MirrorEmojiName)
	}

	if configuration.RetentionDays < 0 {
		return fmt.Errorf("retentionDays must be greater than or equal to zero")
	}
	if configuration.RetentionDays > maximumRetentionDays {
		configuration.RetentionDays = maximumRetentionDays
	}

	if configuration.MaxReadersPerPost <= 0 {
		configuration.MaxReadersPerPost = defaultMaxReadersPerPost
	}
	if configuration.MaxReadersPerPost > maximumMaxReadersPerPost {
		configuration.MaxReadersPerPost = maximumMaxReadersPerPost
	}

	return nil
}

func normalizeEmojiName(value string) string {
	value = strings.TrimSpace(value)
	value = strings.TrimPrefix(value, ":")
	value = strings.TrimSuffix(value, ":")
	return value
}

func asString(key string, value any) (string, error) {
	stringValue, ok := value.(string)
	if !ok {
		return "", fmt.Errorf("configuration %s must be a string", key)
	}
	return stringValue, nil
}

func asBool(key string, value any) (bool, error) {
	boolValue, ok := value.(bool)
	if !ok {
		return false, fmt.Errorf("configuration %s must be a bool", key)
	}
	return boolValue, nil
}

func asInt(key string, value any) (int, error) {
	switch typedValue := value.(type) {
	case int:
		return typedValue, nil
	case int32:
		return int(typedValue), nil
	case int64:
		return int(typedValue), nil
	case float64:
		if typedValue != float64(int(typedValue)) {
			return 0, fmt.Errorf("configuration %s must be an integer", key)
		}
		return int(typedValue), nil
	default:
		return 0, fmt.Errorf("configuration %s must be a number", key)
	}
}
