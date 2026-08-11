import type { StoredProject, SubtitleDocument } from '../core/types';

const DATABASE = 'aegisub-web';
const STORE = 'projects';
const AUTOSAVE_KEY = 'autosave';

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function saveAutosave(document: SubtitleDocument): Promise<void> {
  const database = await openDatabase();
  const value: StoredProject = { version: 1, updatedAt: Date.now(), document };
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite');
    transaction.objectStore(STORE).put(value, AUTOSAVE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  database.close();
}

export async function loadAutosave(): Promise<StoredProject | null> {
  const database = await openDatabase();
  const value = await new Promise<StoredProject | null>((resolve, reject) => {
    const request = database.transaction(STORE).objectStore(STORE).get(AUTOSAVE_KEY);
    request.onsuccess = () => resolve((request.result as StoredProject | undefined) ?? null);
    request.onerror = () => reject(request.error);
  });
  database.close();
  return value;
}
