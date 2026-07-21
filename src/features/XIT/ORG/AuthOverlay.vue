<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AuthSession } from '@src/infrastructure/org-api/types';
import * as authApi from '@src/infrastructure/org-api/auth';
import { HttpError } from '@src/infrastructure/org-api/client';
import { companyStore } from '@src/infrastructure/prun-api/data/company';
import { usersStore } from '@src/infrastructure/prun-api/data/users';
import Header from '@src/components/Header.vue';
import PrunButton from '@src/components/PrunButton.vue';
import Active from '@src/components/forms/Active.vue';
import TextInput from '@src/components/forms/TextInput.vue';

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
    <!--
      用 PrUn 官方 panel + Header + forms/Active + PrunButton。
      tab 切换走 PrUn 自带 Tabs 样式（带 toggleIndicator）。
    -->
    <div :class="[C.Panel.panel, C.fonts.fontRegular, $style.card]">
      <Header>组织管理面板</Header>

      <div :class="C.Tabs.tabs">
        <div :class="C.Tabs.header" @click="mode = 'login'">
          <template v-if="mode === 'login'">
            <a :class="[C.Tabs.tabActive, C.Tabs.tab, C.fonts.fontRegular, C.type.typeRegular]"
              >登录</a
            >
            <div
              :class="[
                C.Tabs.toggleIndicator,
                C.Tabs.toggleIndicatorActive,
                C.effects.shadowPrimary,
              ]" />
          </template>
          <template v-else>
            <a :class="[C.Tabs.tab, C.fonts.fontRegular, C.type.typeRegular]">登录</a>
            <div :class="[C.Tabs.toggleIndicator]" />
          </template>
        </div>
        <div :class="C.Tabs.header" @click="mode = 'register'">
          <template v-if="mode === 'register'">
            <a :class="[C.Tabs.tabActive, C.Tabs.tab, C.fonts.fontRegular, C.type.typeRegular]"
              >注册（需邀请码）</a
            >
            <div
              :class="[
                C.Tabs.toggleIndicator,
                C.Tabs.toggleIndicatorActive,
                C.effects.shadowPrimary,
              ]" />
          </template>
          <template v-else>
            <a :class="[C.Tabs.tab, C.fonts.fontRegular, C.type.typeRegular]">注册（需邀请码）</a>
            <div :class="[C.Tabs.toggleIndicator]" />
          </template>
        </div>
      </div>

      <form :class="$style.form" @submit.prevent="onSubmit">
        <Active label="邮箱">
          <TextInput v-model="email" type="email" />
        </Active>
        <Active label="密码">
          <TextInput v-model="password" type="password" />
        </Active>
        <template v-if="mode === 'register'">
          <Active label="邀请码">
            <TextInput v-model="inviteCode" />
          </Active>
          <div :class="$style.identity">
            将绑定 PrUn 身份：
            <strong>{{ prunUsername || '未读取到' }}</strong>
            / {{ companyCode || '未读取到' }}
          </div>
        </template>

        <div v-if="errorMessage" :class="$style.error">{{ errorMessage }}</div>

        <div :class="$style.submitRow">
          <PrunButton primary type="submit" :disabled="!canSubmit">
            {{ loading ? '处理中...' : mode === 'login' ? '登录' : '注册' }}
          </PrunButton>
        </div>
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
  max-width: 460px;
  padding: 16px 20px 20px;
}
.form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.identity {
  font-size: 12px;
  color: var(--text-muted);
  padding: 8px;
  background: var(--panel-background-alt);
  border: 1px solid var(--panel-border);
}
.error {
  color: var(--text-negative);
  font-size: 12px;
  padding: 4px 0;
}
.submitRow {
  margin-top: 6px;
}
</style>
