/** 稳定的 v1 接口。两仓库独立发布；兼容测试核对本文件与历史协议样本。 */
export const PROTOCOL_VERSION = 1;
export const CURRENT_CAPABILITIES = Object.freeze({
    chat: true, controls: true, attachments: true, actions: true, images: true, queue: true, stream: true,
});
export type RemoteCapabilities = Partial<Record<keyof typeof CURRENT_CAPABILITIES, boolean>>;
export const BASIC_CAPABILITIES: RemoteCapabilities = Object.freeze({chat: true});

export function readCapabilities(value: unknown): RemoteCapabilities | undefined {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const result: RemoteCapabilities = {chat: true};
    for (const key of Object.keys(CURRENT_CAPABILITIES) as (keyof RemoteCapabilities)[]) {
        if (key in value) result[key] = (value as Record<string, unknown>)[key] === true;
    }
    return result;
}

export function requiredCapability(operation: {kind: string; section?: string; attachmentIds?: string[]}): keyof RemoteCapabilities | undefined {
    switch (operation.kind) {
        case 'session.list': case 'session.snapshot': case 'turn.stop': return 'chat';
        case 'session.create': case 'message.send': return operation.attachmentIds?.length ? 'attachments' : 'chat';
        case 'session.controls': return operation.section === 'queue' ? 'queue' : 'controls';
        case 'session.configure': case 'question.answer': case 'permission.resolve': return 'controls';
        case 'session.rename': case 'session.pin': case 'session.delete': case 'session.compact':
        case 'message.read': case 'message.edit': case 'message.regenerate': return 'actions';
        case 'session.image': return 'images';
        case 'message.enqueue': case 'queue.remove': case 'queue.resume': return 'queue';
        default: return undefined;
    }
}

export function supportsOperation(capabilities: RemoteCapabilities, operation: Parameters<typeof requiredCapability>[0]): boolean {
    const required = requiredCapability(operation);
    return !!required && capabilities[required] === true && (!operation.attachmentIds?.length || capabilities.attachments === true);
}
