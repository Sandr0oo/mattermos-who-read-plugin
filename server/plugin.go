package main

import (
	"sync"

	"github.com/mattermost/mattermost/server/public/plugin"
)

// Plugin implements the Mattermost server-side plugin hooks for hybrid read receipts.
type Plugin struct {
	plugin.MattermostPlugin

	configurationLock sync.RWMutex
	configuration     *configuration
	store             *KVStore
}

func (p *Plugin) OnActivate() error {
	if p.store == nil && p.API != nil {
		p.store = NewKVStore(p.API)
	}

	if p.getConfiguration() == nil {
		p.setConfiguration(defaultConfiguration())
	}

	return nil
}

func (p *Plugin) OnDeactivate() error {
	return nil
}

func (p *Plugin) OnConfigurationChange() error {
	configuration, err := loadConfiguration(p.API)
	if err != nil {
		return err
	}

	p.setConfiguration(configuration)
	if p.store == nil && p.API != nil {
		p.store = NewKVStore(p.API)
	}

	p.publishConfigChanged(configuration)

	return nil
}

func (p *Plugin) getConfiguration() *configuration {
	p.configurationLock.RLock()
	defer p.configurationLock.RUnlock()

	if p.configuration == nil {
		return nil
	}

	return p.configuration.Clone()
}

func (p *Plugin) setConfiguration(configuration *configuration) {
	p.configurationLock.Lock()
	defer p.configurationLock.Unlock()

	p.configuration = configuration.Clone()
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
