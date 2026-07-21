<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AuthSession } from '@src/infrastructure/org-api/types';
import * as authApi from '@src/infrastructure/org-api/auth';
import { HttpError } from '@src/infrastructure/org-api/client';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import { usersStore } from '@src/infrastructure/prun-api/data/users';

type Mode = 'login' | 'register';

const mode = ref<Mode>('login');
const email = ref('');
const password = ref('');
const inviteCode = ref('');
const errorMessage = ref('');
const loading = ref(false);

const emit = defineEmits<{
  (e: 'authenticated', session: AuthSession): void;
}>();

// 当前 PrUn 身份（从 store 读取，修正后 API 形态）
const prunUsername = computed(() => usersStore.all.value?.[0]?.username ?? '');
const companyCode = computed(() => companyStore.value?.code ?? '');

const canSubmit = computed(() => {
  if (loading.value) {
    return false;
  }
  if (!email.value || !password.value) {
    return false;
  }
  if (mode.value === 'register') {
    if (!inviteCode.value) {
      return false;
    }
    if (!prunUsername.value || !companyCode.value) {
      return false;
    }
  }
  return true;
});

async function onSubmit() {
  if (!canSubmit.value) {
    return;
  }
  loading.value = true;
  errorMessage.value = '';
  try {
    let session: AuthSession;
    if (mode.value === 'register') {
      session = await authApi.register({
        email: email.value,
        password: password.value,
        inviteCode: inviteCode.value,
        prunUsername: prunUsername.value,
        companyCode: companyCode.value,
      });
    } else {
      session = await authApi.login({
        email: email.value,
        password: password.value,
      });
      // 登录后校验当前 PrUn 身份与后端记录一致
      if (
        session.user.prunUsername !== prunUsername.value ||
        session.user.companyCode !== companyCode.value
      ) {
        await authApi.logout();
        throw new HttpError(
          400,
          'PRUN_IDENTITY_MISMATCH',
          '当前 PrUn 身份与注册时不一致，请切换 PrUn 账号或重新登录',
        );
      }
    }
    emit('authenticated', session);
  } catch (err) {
    if (err instanceof HttpError) {
      errorMessage.value = err.message;
    } else {
      errorMessage.value = '网络错误，请稍后重试';
    }
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <div :class="$style.overlay">
    <div :class="$style.card">
      <h2 :class="$style.title">组织管理面板</h2>
      <div :class="$style.tabs">
        <button :class="[$style.tab, mode === 'login' && $style.active]" @click="mode = 'login'">
          登录
        </button>
        <button
          :class="[$style.tab, mode === 'register' && $style.active]"
          @click="mode = 'register'">
          注册（需邀请码）
        </button>
      </div>

      <form :class="$style.form" @submit.prevent="onSubmit">
        <label :class="$style.field">
          <span>邮箱</span>
          <input v-model="email" type="email" required autocomplete="email" />
        </label>
        <label :class="$style.field">
          <span>密码</span>
          <input v-model="password" type="password" required autocomplete="current-password" />
        </label>
        <template v-if="mode === 'register'">
          <label :class="$style.field">
            <span>邀请码</span>
            <input v-model="inviteCode" required placeholder="10 字符" />
          </label>
          <div :class="$style.identity">
            将绑定 PrUn 身份：
            <strong>{{ prunUsername || '未读取到' }}</strong>
            / {{ companyCode || '未读取到' }}
          </div>
        </template>

        <div v-if="errorMessage" :class="$style.error">{{ errorMessage }}</div>

        <button type="submit" :disabled="!canSubmit" :class="$style.submit">
          {{ loading ? '处理中...' : mode === 'login' ? '登录' : '注册' }}
        </button>
      </form>
    </div>
  </div>
</template>

<style module>
.overlay {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.card {
  width: 100%;
  max-width: 420px;
  background: var(--panel-background);
  border: 1px solid var(--panel-border);
  padding: 24px;
}
.title {
  margin: 0 0 16px;
  font-size: 18px;
}
.tabs {
  display: flex;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--panel-border);
}
.tab {
  flex: 1;
  padding: 8px;
  background: transparent;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
}
.tab.active {
  color: var(--text);
  border-bottom: 2px solid var(--accent);
}
.form {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 13px;
}
.field input {
  padding: 6px 8px;
  border: 1px solid var(--panel-border);
  background: var(--input-background);
  color: var(--text);
}
.identity {
  font-size: 12px;
  color: var(--text-muted);
  padding: 8px;
  background: var(--panel-background-alt);
}
.error {
  color: var(--text-negative);
  font-size: 12px;
}
.submit {
  margin-top: 8px;
  padding: 8px 16px;
  border: 1px solid var(--panel-border);
  background: var(--accent);
  color: var(--text-on-accent);
  cursor: pointer;
}
.submit:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
