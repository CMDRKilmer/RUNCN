// src/infrastructure/org-api/notes.ts
import type { TaskNote } from './types';
import { request } from './client';

export async function listNotes(taskId: string): Promise<TaskNote[]> {
  return request<TaskNote[]>(`/tasks/${taskId}/notes`);
}

export async function createNote(taskId: string, content: string): Promise<TaskNote> {
  return request<TaskNote>(`/tasks/${taskId}/notes`, {
    method: 'POST',
    body: { content },
  });
}
