package main

import (
	"fmt"
	"regexp"
	"strings"
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
)

var mirrorEmojiNamePattern = regexp.MustCompile(`^[a-zA-Z0-9_+\-]+$`)

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

	if err := applyRawConfiguration(configuration, api.GetPluginConfig()); err != nil {
		return nil, err
	}

	if err := normalizeConfiguration(configuration); err != nil {
		return nil, err
	}

	return configuration, nil
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

	if value, ok := raw["readReceiptMode"]; ok {
		stringValue, err := asString("readReceiptMode", value)
		if err != nil {
			return err
		}
		configuration.ReadReceiptMode = ReadReceiptMode(stringValue)
	}

	if value, ok := raw["mirrorEmojiName"]; ok {
		stringValue, err := asString("mirrorEmojiName", value)
		if err != nil {
			return err
		}
		configuration.MirrorEmojiName = stringValue
	}

	if value, ok := raw["mirrorReactionsEnabled"]; ok {
		boolValue, err := asBool("mirrorReactionsEnabled", value)
		if err != nil {
			return err
		}
		configuration.MirrorReactionsEnabled = boolValue
	}

	if value, ok := raw["hideMirrorReactionsInWeb"]; ok {
		boolValue, err := asBool("hideMirrorReactionsInWeb", value)
		if err != nil {
			return err
		}
		configuration.HideMirrorReactionsInWeb = boolValue
	}

	if value, ok := raw["fallbackToStandardEyes"]; ok {
		boolValue, err := asBool("fallbackToStandardEyes", value)
		if err != nil {
			return err
		}
		configuration.FallbackToStandardEyes = boolValue
	}

	if value, ok := raw["showReaderNames"]; ok {
		boolValue, err := asBool("showReaderNames", value)
		if err != nil {
			return err
		}
		configuration.ShowReaderNames = boolValue
	}

	if value, ok := raw["retentionDays"]; ok {
		intValue, err := asInt("retentionDays", value)
		if err != nil {
			return err
		}
		configuration.RetentionDays = intValue
	}

	if value, ok := raw["maxReadersPerPost"]; ok {
		intValue, err := asInt("maxReadersPerPost", value)
		if err != nil {
			return err
		}
		configuration.MaxReadersPerPost = intValue
	}

	return nil
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
