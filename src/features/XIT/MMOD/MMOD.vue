<script setup lang="ts">
import PrunButton from '@src/components/PrunButton.vue';
import {
  fetchPluginUsers,
  fetchMyRole,
  isAuthenticated,
  FactionApiError,
} from '../FACTION/use-faction-api';
import type { MemberRole, PluginUser } from '../FACTION/types';
import css from './MMOD.module.css';

const users = ref<PluginUser[]>([]);
const loading = ref(false);
const error = ref('');
const accessGranted = ref(false);
const accessLoading = ref(false);
const accessMessage = ref('正在检查组织权限...');
const myRole = ref<MemberRole | ''>('');

function lockView() {
  accessGranted.value = false;
  users.value = [];
  error.value = '';
  accessMessage.value = '列表已隐藏。点击重新检测权限可再次查看。';
}

async function verifyAccess() {
  accessLoading.value = true;
  accessGranted.value = false;
  error.value = '';
  users.value = [];

  if (!isAuthenticated()) {
    accessMessage.value = '请先在 XIT FACTION 登录组织面板。';
    accessLoading.value = false;
    return;
  }

  try {
    const role = await fetchMyRole();
    myRole.value = role;

    if (role !== 'executive') {
      accessMessage.value = '当前账号不是 executive，无法查看插件用户统计。';
      return;
    }

    accessGranted.value = true;
    accessMessage.value = '';
    await loadData();
  } catch (e) {
    if (e instanceof FactionApiError) {
      accessMessage.value = e.response.message;
    } else {
      accessMessage.value = '无法验证组织权限，请稍后重试。';
    }
  } finally {
    accessLoading.value = false;
  }
}

function formatLastActive(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  return `${days}天前`;
}

async function loadData() {
  if (!accessGranted.value) return;

  loading.value = true;
  error.value = '';
  try {
    const result = await fetchPluginUsers();
    users.value = result.users;
  } catch (e) {
    if (e instanceof FactionApiError) {
      error.value = e.response.message;
    }
  } finally {
    loading.value = false;
  }
}

onMounted(verifyAccess);
</script>

<template>
  <div :class="css.container">
    <template v-if="!accessGranted">
      <div :class="css.toolbar">
        <span :class="css.title">插件用户统计</span>
      </div>

      <div :class="css.accessPanel">
        <div :class="css.accessHint">{{ accessMessage }}</div>
        <div v-if="myRole && myRole !== 'executive'" :class="css.roleHint">
          当前角色：{{ myRole }}
        </div>
        <PrunButton dark :disabled="accessLoading" @click="verifyAccess">
          {{ accessLoading ? '检查中...' : '重新检测权限' }}
        </PrunButton>
      </div>
    </template>

    <template v-else>
      <div :class="css.toolbar">
        <span :class="css.title">插件用户 ({{ users.length }})</span>
        <div :class="css.actions">
          <PrunButton dark @click="loadData">刷新</PrunButton>
          <PrunButton dark @click="lockView">隐藏</PrunButton>
        </div>
      </div>

      <div v-if="error" :class="css.error">{{ error }}</div>
      <div v-if="loading" :class="css.message">加载中...</div>

      <template v-else>
        <div v-if="users.length === 0" :class="css.message">暂无用户数据</div>

        <div :class="css.list">
          <div v-for="user in users" :key="user.username" :class="css.userRow">
            <div :class="css.userInfo">
              <span :class="css.username">{{ user.username }}</span>
              <span :class="css.company">{{ user.companyName }}</span>
            </div>
            <span :class="css.lastActive">{{ formatLastActive(user.lastActive) }}</span>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>
