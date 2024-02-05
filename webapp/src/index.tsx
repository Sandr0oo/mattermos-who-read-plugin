import { Store, Action } from 'redux';
import { GlobalState } from 'mattermost-redux/types/store';
import { WebSocketMessage } from "@mattermost/types/lib/websocket";
import { PluginRegistry } from '@/types/mattermost-webapp';
import { addReaction, getPostThread, removeReaction } from 'mattermost-redux/actions/posts';
import { getMe, loadMe } from 'mattermost-redux/actions/users';
import { makeGetPostsForThread, makeGetPostsInChannel, getLastPostPerChannel, getReactionsForPosts} from 'mattermost-redux/selectors/entities/posts';
import { $ID, RelationOneToOne, RelationOneToMany, Dictionary } from "mattermost-redux/types/utilities";
import { Post, PostList, PostMetadata } from "mattermost-redux/types/posts"
import { Channel } from "mattermost-redux/types/channels"

import manifest from '@/manifest';
import { UserProfile } from 'mattermost-redux/types/users';

interface ThreadReadChangedEvent {
    channel_id: string;
    previous_unread_mentions: number;
    previous_unread_replies: number;
    thread_id: string;
    timestamp: number;
    unread_mentions: number;
    unread_replies: number;
}

interface ChannelTimes {
    [channelId: string]: number;
  }
  

export default class Plugin {

    LastReactedPost : Dictionary<Post>;
    EmojiForReaction : string = "eyes"
    Me : UserProfile;

    constructor() {
        this.LastReactedPost = {} as Dictionary<Post>;
        this.Me = {} as UserProfile;
    }

    public async initialize(registry: PluginRegistry, store: Store<GlobalState, Action<Record<string, unknown>>>) {
        
        this.Me = (await store.dispatch(getMe() as any)).data as UserProfile;
        

        registry.registerWebSocketEventHandler('multiple_channels_viewed', (event: WebSocketMessage<ChannelTimes>) => {

            // console.log('multiple_channels_viewed');

            let currentStore = store.getState();


            // Получаем последнии сообщения из всех каналов
            let lastPostsInChannel : RelationOneToOne<Channel, Post> = getLastPostPerChannel(currentStore);

            // Получаем Id канала в котором произошло событие просмотра каналаю.
            let channelIdEvent = Object.keys(event.data.channel_times)[0];
            
            // Получаем последний пост в канале, который был просмотрен
            const lastPostFromViewedChannel = lastPostsInChannel[channelIdEvent];

            const isLastPostFromViewedChannelByMe = lastPostFromViewedChannel.user_id == this.Me.id;

            // Оказалось, что событие multiple_channels_viewed может произойти даже,
            // если кто-то просто вышел из треда или в треде на который человек не подписан
            // прислали сообщение.
            // Короче, это проверка нужна, чтобы не долбить сервак просто так.
            // Если реакция о просмотре уже установленна на последний пост в канале,
            // то ничего не делаем.
            if(this.LastReactedPost[channelIdEvent]?.id == lastPostFromViewedChannel.id || localStorage[channelIdEvent] == lastPostFromViewedChannel.id ) {
                // console.log("Возникло событие multiple_channels_viewed, хотя сообщений в канале не было.");
                return;
            }
            // Проверка наличия поста на котром уже стоит реакция
            if(this.LastReactedPost[channelIdEvent]) {
                // Удаляем реакцию с поста
                store.dispatch(removeReaction(this.LastReactedPost[channelIdEvent].id, this.EmojiForReaction) as any)
            }
            else if (localStorage[channelIdEvent]) {
                store.dispatch(removeReaction(localStorage[channelIdEvent], this.EmojiForReaction) as any)
            }

            // Если пост отправлен не текущим пользователем
            if(!isLastPostFromViewedChannelByMe)
            {
                // Ставим реакцию на последний просмотренный пост
                store.dispatch(addReaction(lastPostFromViewedChannel.id, this.EmojiForReaction) as any);
            }
                
            // Запоминаем на какой пост мы поставили последнюю реакцию, чтобы 
            // потом ее убрать.
            this.LastReactedPost[channelIdEvent] = lastPostFromViewedChannel;
            localStorage[channelIdEvent] = lastPostFromViewedChannel.id;
        });
        
        // registry.registerWebSocketEventHandler('thread_read_changed', async (event) => {
        //     console.log('thread_read_changed');

        //     // В каком именно треде произошло событие.
        //     let threadId = event.data.thread_id
        //     // Список сообщений в треде. Убирем из списка перывый пост, потому что он 
        //     // он виден в основном канале и на нем должна остать реакция. 
        //     let postList = ((await store.dispatch(getPostThread(threadId) as any)).data.posts as Post[]);
        //     postList = Object.values(postList).sort((a, b) => a.create_at - b.create_at).slice(1);

        //     Object.entries(postList).forEach(([key, value]) => {
        //         let postMetaData = value.metadata as PostMetadata;

        //         if(postMetaData?.reactions){
        //             console.log("postMeta", postMetaData?.reactions)
        //             let currentUserReactions = postMetaData.reactions.filter((r) => r.user_id == this.Me.id && r.emoji_name == this.EmojiForReaction);
        //             console.log("currentUserReactions", currentUserReactions);
        //             currentUserReactions.forEach(element => {
        //                 console.log("element", element);
        //                 store.dispatch(removeReaction(element.post_id, this.EmojiForReaction) as any)
                        
        //             });
                    
        //         }
        //       });

        //     if(Object.entries(postList).length >= 1 )
        //     {
        //         const postListValues = Object.values(postList);
                
        //         await store.dispatch(addReaction(postListValues[postListValues.length - 1].id, this.EmojiForReaction) as any);
        //     }

        // });

    }
}

declare global {
    interface Window {
        registerPlugin(pluginId: string, plugin: Plugin): void;
    }
}

window.registerPlugin(manifest.id, new Plugin());
