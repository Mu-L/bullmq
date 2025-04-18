export type KeysMap = { [index in string]: string };

export class QueueKeys {
  constructor(public readonly prefix = 'bull') {}

  getKeys(name: string): KeysMap {
    const keys: { [index: string]: string } = {};
    [
      '',
      'active',
      'wait',
      'waiting-children',
      'paused',
      'id',
      'delayed',
      'prioritized',
      'stalled-check',
      'completed',
      'failed',
      'stalled',
      'repeat',
      'limiter',
      'meta',
      'events',
      'pc', // priority counter key
      'marker', // marker key
      'de', // deduplication key
    ].forEach(key => {
      keys[key] = this.toKey(name, key);
    });

    return keys;
  }

  toKey(name: string, type: string): string {
    return `${this.getQueueQualifiedName(name)}:${type}`;
  }

  getQueueQualifiedName(name: string): string {
    return `${this.prefix}:${name}`;
  }
}
