package main

import (
	"sync"

	"github.com/mattermost/mattermost/server/public/plugin"
)

// Plugin implements the Mattermost server-side plugin hooks for hybrid read receipts.
type Plugin struct {
	plugin.MattermostPlugin

	configurationLock        sync.RWMutex
	configurationRefreshLock sync.Mutex
	configuration            *configuration
	configurationDirty       bool
	configurationGeneration  uint64
	store                    *KVStore
}

func (p *Plugin) OnActivate() error {
	if p.store == nil && p.API != nil {
		p.store = NewKVStore(p.API)
	}

	configuration, err := p.refreshConfiguration(true)
	if err != nil {
		p.logConfigurationError("failed to load plugin configuration; using fallback", err)
		if configuration == nil {
			p.setConfiguration(defaultConfiguration())
		}
	}

	return nil
}

func (p *Plugin) OnDeactivate() error {
	return nil
}

func (p *Plugin) OnConfigurationChange() error {
	// Do not synchronously call configuration API methods here: Mattermost may invoke
	// this hook while processing /api/v4/config/patch, and re-entering config APIs can
	// block the patch request. Mark the cached config dirty instead; regular plugin
	// logic refreshes it lazily on the next use, while clients still get a websocket
	// signal to invalidate their caches.
	p.markConfigurationDirty()
	p.publishConfigChanged()
	return nil
}

func (p *Plugin) getConfiguration() *configuration {
	configuration, err := p.refreshConfiguration(false)
	if err != nil {
		p.logConfigurationError("failed to refresh plugin configuration; using cached configuration", err)
	}

	return configuration
}

func (p *Plugin) getFreshConfiguration() *configuration {
	configuration, err := p.refreshConfiguration(true)
	if err != nil {
		p.logConfigurationError("failed to refresh plugin configuration; using cached configuration", err)
	}

	return configuration
}

func (p *Plugin) refreshConfiguration(force bool) (*configuration, error) {
	dirty, generation := p.configurationDirtyState()
	if !force && !dirty {
		return p.cachedConfigurationOrDefault(), nil
	}

	p.configurationRefreshLock.Lock()
	defer p.configurationRefreshLock.Unlock()

	dirty, generation = p.configurationDirtyState()
	if !force && !dirty {
		return p.cachedConfigurationOrDefault(), nil
	}

	configuration, err := loadConfiguration(p.API)
	if err != nil {
		fallback := p.cachedConfigurationOrDefault()
		p.setConfigurationForGeneration(fallback, generation)
		return fallback, err
	}

	p.setConfigurationForGeneration(configuration, generation)
	return configuration, nil
}

func (p *Plugin) cachedConfigurationOrDefault() *configuration {
	configuration := p.getCachedConfiguration()
	if configuration == nil {
		return defaultConfiguration()
	}

	return configuration
}

func (p *Plugin) getCachedConfiguration() *configuration {
	p.configurationLock.RLock()
	defer p.configurationLock.RUnlock()

	if p.configuration == nil {
		return nil
	}

	return p.configuration.Clone()
}

func (p *Plugin) isConfigurationDirty() bool {
	dirty, _ := p.configurationDirtyState()
	return dirty
}

func (p *Plugin) configurationDirtyState() (bool, uint64) {
	p.configurationLock.RLock()
	defer p.configurationLock.RUnlock()

	return p.configurationDirty, p.configurationGeneration
}

func (p *Plugin) markConfigurationDirty() *configuration {
	p.configurationLock.Lock()
	defer p.configurationLock.Unlock()

	p.configurationDirty = true
	p.configurationGeneration++
	if p.configuration == nil {
		return nil
	}

	return p.configuration.Clone()
}

func (p *Plugin) setConfiguration(configuration *configuration) {
	p.configurationLock.Lock()
	defer p.configurationLock.Unlock()

	p.configuration = configuration.Clone()
	p.configurationDirty = false
}

func (p *Plugin) setConfigurationForGeneration(configuration *configuration, generation uint64) {
	p.configurationLock.Lock()
	defer p.configurationLock.Unlock()

	p.configuration = configuration.Clone()
	if p.configurationGeneration == generation {
		p.configurationDirty = false
	}
}

func (p *Plugin) logConfigurationError(message string, err error) {
	if p.API == nil || err == nil {
		return
	}

	p.API.LogError(message, "error", err.Error())
}

func (p *Plugin) getStore() *KVStore {
	if p.store != nil {
		return p.store
	}

	if p.API == nil {
		return nil
	}

	p.store = NewKVStore(p.API)
	return p.store
}
