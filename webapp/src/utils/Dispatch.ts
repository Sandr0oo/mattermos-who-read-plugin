import {Store, Action} from 'redux';
import {GlobalState} from 'mattermost-redux/types/store';

export type AppStore = Store<GlobalState, Action<Record<string, unknown>>>;

export function dispatchAsync(store: AppStore, action: any): Promise<any> {
    return store.dispatch(action);
}
