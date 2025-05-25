// WebDAV 默认配置
const DEFAULT_WEBDAV_CONFIG = {
  url: 'https://alist.10023456.xyz/dav',
  username: 'webdav',
  password: 'webdav'
};

// 公告栏配置
const ANNOUNCEMENT_CONFIG = {
  url: 'https://alist.10023456.xyz/d/share/webdav/libretv-advice.txt?sign=Hx1OSgOgS7yr_5O3H3m5-DAzZ0Bvy6Dut4cnzwcv1tU=:0',
  checkInterval: 24 * 60 * 60 * 1000, // 24小时检查一次
  storageKey: 'lastAnnouncementId', // 存储已显示的公告ID
  checkTimeKey: 'lastAnnouncementCheckTime' // 上次检查公告的时间
};

// 不参与同步的键名黑名单
const SYNC_BLACKLIST = [
  'sessionId',
  'deviceId',
  'tempData',
  'token',
  'cloudSyncEnabled', // 同步开关状态不应被同步
  'lastSyncTime',     // 同步时间戳不应被同步
  'hasInitializedDefaults', // 初始化状态不应被同步
  'credentialId',      // 凭据ID不应被同步
  'syncLock',          // 同步锁不应被同步
  'syncLockTimestamp'  // 同步锁时间戳不应被同步
];

// 黑名单前缀，任何以这些前缀开头的键都不会被同步
const SYNC_BLACKLIST_PREFIXES = [
  '_temp',           // 临时数据前缀
  'debug_',          // 调试数据前缀
  'temp_',           // 临时数据前缀
  'videoProgress_'   // 视频进度前缀，不再同步视频进度数据
];

// 同步锁配置
const SYNC_LOCK_CONFIG = {
  lockKey: 'syncLock',
  lockTimeKey: 'syncLockTimestamp',
  lockTimeout: 120000, // 锁超时时间，增加到120秒
  heartbeatInterval: 30000 // 心跳间隔，增加到30秒
};

// WebDAV 客户端
class WebDAVClient {
  constructor(credentialId) {
    if (!credentialId) {
      throw new Error('凭据 ID 不能为空');
    }
    this.config = DEFAULT_WEBDAV_CONFIG;
    this.credentialId = credentialId;
  }

  // 测试 WebDAV 连接
  async testConnection() {
    try {
      // 只测试基本连接，不创建测试文件
      const basicTest = await fetch(this.config.url, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.config.username}:${this.config.password}`),
          'Depth': '0'
        }
      });

      if (!basicTest.ok) {
        console.error('WebDAV 连接测试失败:', basicTest.status);
        return false;
      }

      // 连接成功
      console.log('WebDAV 连接测试成功');
      return true;
    } catch (e) {
      console.error('WebDAV 连接测试失败:', e);
      return false;
    }
  }

  // 上传数据到 WebDAV
  async uploadData(data) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    try {
      const response = await fetch(`${this.config.url}/libretv-${this.credentialId}.json`, {
        method: 'PUT',
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.config.username}:${this.config.password}`),
          'Content-Type': 'application/json'
        },
        body: blob
      });
      return response.ok;
    } catch (e) {
      console.error('上传数据失败:', e);
      return false;
    }
  }

  // 从 WebDAV 下载数据
  async downloadData() {
    try {
      const response = await fetch(`${this.config.url}/libretv-${this.credentialId}.json`, {
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.config.username}:${this.config.password}`)
        }
      });
      if (!response.ok) return null;
      return await response.json();
    } catch (e) {
      console.error('下载数据失败:', e);
      return null;
    }
  }
}

// 同步管理器
class SyncManager {
  constructor() {
    // 检查是否已存在实例，防止多个标签页/iframe中重复初始化
    if (window.syncManagerInitialized) {
      console.log('检测到SyncManager已在其他框架中初始化，本实例将不执行同步操作');
      this.isDisabled = true;
      return;
    }
    
    // 标记SyncManager已初始化
    window.syncManagerInitialized = true;
    this.isDisabled = false;
    
    this.syncEnabled = localStorage.getItem('cloudSyncEnabled') === 'true';
    this.isSyncingFromCloud = false;
    this.webdavClient = null;
    this.credentialId = localStorage.getItem('credentialId') || '';
    this.lastSyncTime = localStorage.getItem('lastSyncTime') || 0;
    this.syncInterval = 30 * 60 * 1000; // 30分钟同步一次
    this.syncDebounceTimer = null;
    this.syncInProgress = false;
    this.syncStatusIcon = null;
    this.manualSyncBtn = null; // 添加手动同步按钮引用
    this.isManualSync = false;
    
    // 节流控制相关变量
    this.lastStorageEventTime = 0;
    this.storageEventThrottleDelay = 3000; // 节流延迟，3秒内只处理一次同一键的变化
    this.lastHandledKeys = {}; // 记录每个键最后处理的时间
    this.ignoredEventCount = 0; // 记录被忽略的事件数量
    
    // 页面标识
    this.pageId = this.generatePageId();
    
    // 页面活跃状态
    this.isPageActive = true;
    
    // 同步锁相关
    this.lockHeartbeatTimer = null;
    this.syncChannel = new BroadcastChannel('libretv_sync_channel');
    
    // 检查当前页面类型
    this.isSettingsPage = this.checkIsSettingsPage();
    
    // 上次同步的数据快照
    this.lastSyncDataSnapshot = null;
    
    // 初始化
    this.initSyncStatusIcon();
    this.addStyles();
    this.setupEventListeners();
    
    // 只在设置页面初始化UI
    if (this.isSettingsPage) {
      this.initUI();
    }
    
    // 检查公告
    this.checkAnnouncement();
    
    // 设置页面可见性监听
    this.setupVisibilityListener();
    
    // 设置定期清理，每小时清理一次缓存的处理记录
    this.setupPeriodicCleanup();
    
    console.log(`SyncManager实例已初始化，页面ID: ${this.pageId}`);
  }
  
  // 检查当前页面是否为设置页面
  checkIsSettingsPage() {
    // 检查URL路径
    const isIndexPage = window.location.pathname === '/' || 
                        window.location.pathname.endsWith('/index.html');
    
    // 检查特定DOM元素是否存在
    const hasSettingsElements = document.getElementById('credentialId') && 
                               document.getElementById('cloudSyncBtn');
    
    return isIndexPage && hasSettingsElements;
  }

  // 生成页面唯一标识
  generatePageId() {
    return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
  }
  
  // 设置页面可见性监听
  setupVisibilityListener() {
    document.addEventListener('visibilitychange', () => {
      this.isPageActive = document.visibilityState === 'visible';
      
      // 如果页面变为可见，并且持有锁，则更新心跳
      if (this.isPageActive && this.isHoldingLock()) {
        this.updateLockHeartbeat();
      }
      
      // 如果页面变为不可见，并且持有锁，则释放锁
      if (!this.isPageActive && this.isHoldingLock()) {
        this.releaseSyncLock();
      }
    });
    
    // 页面关闭前释放锁
    window.addEventListener('beforeunload', () => {
      if (this.isHoldingLock()) {
        this.releaseSyncLock();
      }
    });
  }

  // 设置事件监听器
  setupEventListeners() {
    // 检查实例是否已禁用
    if (this.isDisabled) return;
    
    // 监听 localStorage 变化
    window.addEventListener('storage', this.handleStorageChange.bind(this));
    
    // 监听同步通道消息
    this.syncChannel.addEventListener('message', this.handleSyncMessage.bind(this));
    
    // 重写 localStorage 的 setItem 方法，添加节流控制
    const originalSetItem = localStorage.setItem;
    const self = this;
    
    localStorage.setItem = function(key, value) {
      // 检查是否是被忽略的键（与isBlacklistedKey保持一致）
      const isIgnoredKey = SYNC_BLACKLIST.includes(key) || 
                           SYNC_BLACKLIST_PREFIXES.some(prefix => key.startsWith(prefix)) ||
                           key === 'lastSyncTime' || 
                           key === SYNC_LOCK_CONFIG.lockKey || 
                           key === SYNC_LOCK_CONFIG.lockTimeKey;
      
      // 获取旧值
      const oldValue = localStorage.getItem(key);
      
      // 调用原始的 setItem 方法
      originalSetItem.call(localStorage, key, value);
      
      // 如果值没有变化或是被忽略的键，不触发事件
      if (oldValue === value || isIgnoredKey || self.isDisabled || self.isSyncingFromCloud) {
        return;
      }
      
      // 创建自定义事件
      const event = new StorageEvent('storage', {
        key: key,
        newValue: value,
        oldValue: oldValue,
        storageArea: localStorage,
        url: window.location.href
      });
      
      // 触发事件
      window.dispatchEvent(event);
    };
  }
  
  // 处理同步通道消息
  handleSyncMessage(event) {
    // 检查实例是否已禁用
    if (this.isDisabled) return;
    
    const message = event.data;
    
    switch (message.type) {
      case 'lockRequest':
        // 如果当前页面持有锁，则回应
        if (this.isHoldingLock()) {
          this.syncChannel.postMessage({
            type: 'lockResponse',
            pageId: this.pageId,
            hasLock: true
          });
        }
        break;
        
      case 'lockAcquired':
        // 其他页面获取了锁，更新本地状态
        if (message.pageId !== this.pageId) {
          console.log(`页面 ${message.pageId} 获取了同步锁`);
        }
        break;
        
      case 'lockReleased':
        // 锁被释放，可以尝试获取
        if (message.pageId !== this.pageId) {
          console.log(`页面 ${message.pageId} 释放了同步锁`);
        }
        break;
        
      case 'syncComplete':
        // 同步已完成，更新本地状态
        if (message.pageId !== this.pageId) {
          console.log(`页面 ${message.pageId} 完成了同步操作`);
        }
        // 更新最后同步时间
        if (message.lastSyncTime) {
          this.lastSyncTime = message.lastSyncTime;
          localStorage.setItem('lastSyncTime', this.lastSyncTime);
          // 同步完成后，更新本地数据快照
          this.updateDataSnapshot();
        }
        break;
    }
  }
  
  // 尝试获取同步锁
  async acquireSyncLock() {
    // 检查实例是否已禁用
    if (this.isDisabled) return false;
    
    // 如果已经持有锁，直接返回成功
    if (this.isHoldingLock()) {
      console.log(`页面 ${this.pageId} 已持有同步锁`);
      return true;
    }
    
    // 检查锁是否已过期
    const lockCleared = this.checkAndClearExpiredLock();
    
    // 检查是否有其他页面持有锁
    const currentLock = localStorage.getItem(SYNC_LOCK_CONFIG.lockKey);
    if (currentLock && currentLock !== this.pageId) {
      const lockTimestamp = parseInt(localStorage.getItem(SYNC_LOCK_CONFIG.lockTimeKey) || '0');
      const lockAge = Math.floor((Date.now() - lockTimestamp) / 1000);
      console.log(`同步锁被页面 ${currentLock} 持有 (已持有${lockAge}秒)，等待锁释放`);
      return false;
    }
    
    // 如果锁被清除了，添加随机延迟，避免多个页面同时尝试获取锁
    if (lockCleared) {
      // 随机延迟 0-1000ms
      const randomDelay = Math.floor(Math.random() * 1000);
      await new Promise(resolve => setTimeout(resolve, randomDelay));
      
      // 延迟后再次检查锁状态
      const newLock = localStorage.getItem(SYNC_LOCK_CONFIG.lockKey);
      if (newLock && newLock !== this.pageId) {
        console.log(`延迟后发现锁已被页面 ${newLock} 获取，放弃获取锁`);
        return false;
      }
    }
    
    // 尝试获取锁
    localStorage.setItem(SYNC_LOCK_CONFIG.lockKey, this.pageId);
    localStorage.setItem(SYNC_LOCK_CONFIG.lockTimeKey, Date.now().toString());
    
    // 延迟检查，确保真的获取到了锁
    await new Promise(resolve => setTimeout(resolve, 50));
    
    // 再次检查锁状态
    const finalLock = localStorage.getItem(SYNC_LOCK_CONFIG.lockKey);
    if (finalLock !== this.pageId) {
      console.log(`锁获取失败，当前锁被页面 ${finalLock} 持有`);
      return false;
    }
    
    // 广播已获取锁
    this.syncChannel.postMessage({
      type: 'lockAcquired',
      pageId: this.pageId
    });
    
    // 设置锁心跳
    this.startLockHeartbeat();
    
    console.log(`页面 ${this.pageId} 获取了同步锁`);
    return true;
  }
  
  // 释放同步锁
  releaseSyncLock() {
    // 只有持有锁的页面才能释放
    if (!this.isHoldingLock()) {
      return;
    }
    
    // 停止心跳
    this.stopLockHeartbeat();
    
    // 清除锁
    localStorage.removeItem(SYNC_LOCK_CONFIG.lockKey);
    localStorage.removeItem(SYNC_LOCK_CONFIG.lockTimeKey);
    
    // 广播已释放锁
    this.syncChannel.postMessage({
      type: 'lockReleased',
      pageId: this.pageId
    });
    
    console.log(`页面 ${this.pageId} 释放了同步锁`);
  }
  
  // 检查是否持有锁
  isHoldingLock() {
    return localStorage.getItem(SYNC_LOCK_CONFIG.lockKey) === this.pageId;
  }
  
  // 检查并清除过期的锁
  checkAndClearExpiredLock() {
    const lockTimestamp = parseInt(localStorage.getItem(SYNC_LOCK_CONFIG.lockTimeKey) || '0');
    const lockPageId = localStorage.getItem(SYNC_LOCK_CONFIG.lockKey);
    const now = Date.now();
    
    // 如果没有锁，直接返回
    if (!lockPageId) {
      return false;
    }
    
    // 如果锁已过期，则清除
    if (now - lockTimestamp > SYNC_LOCK_CONFIG.lockTimeout) {
      console.log(`检测到过期的同步锁 (页面ID: ${lockPageId}, 超时: ${Math.floor((now - lockTimestamp)/1000)}秒)，正在清除`);
      localStorage.removeItem(SYNC_LOCK_CONFIG.lockKey);
      localStorage.removeItem(SYNC_LOCK_CONFIG.lockTimeKey);
      return true;
    }
    
    return false;
  }
  
  // 开始锁心跳
  startLockHeartbeat() {
    // 先清除可能存在的心跳定时器
    this.stopLockHeartbeat();
    
    // 设置新的心跳定时器
    this.lockHeartbeatTimer = setInterval(() => {
      // 只有在真正持有锁时才更新心跳
      if (this.isHoldingLock()) {
        this.updateLockHeartbeat();
        console.log(`页面 ${this.pageId} 更新了同步锁心跳`);
      } else {
        // 如果发现不再持有锁，停止心跳
        console.log(`页面 ${this.pageId} 不再持有锁，停止心跳`);
        this.stopLockHeartbeat();
      }
    }, SYNC_LOCK_CONFIG.heartbeatInterval);
  }
  
  // 停止锁心跳
  stopLockHeartbeat() {
    if (this.lockHeartbeatTimer) {
      clearInterval(this.lockHeartbeatTimer);
      this.lockHeartbeatTimer = null;
    }
  }
  
  // 更新锁心跳
  updateLockHeartbeat() {
    if (this.isHoldingLock()) {
      localStorage.setItem(SYNC_LOCK_CONFIG.lockTimeKey, Date.now().toString());
    }
  }

  // 初始化UI
  initUI() {
    // 如果不是设置页面，直接返回
    if (!this.isSettingsPage) {
      console.log('当前页面不是设置页面，跳过UI初始化');
      return;
    }
    
    const credentialIdElement = document.getElementById('credentialId');
    const cloudSyncBtnElement = document.getElementById('cloudSyncBtn');
    
    // 初始化云同步设置
    const credentialId = localStorage.getItem('credentialId');
    if (credentialId) {
      credentialIdElement.value = credentialId;
    }

    // 初始化按钮状态
    this.updateCloudSyncButton();

    // 添加凭据ID输入框的事件监听
    credentialIdElement.addEventListener('input', (e) => {
      const credentialId = e.target.value.trim();
      if (credentialId) {
        localStorage.setItem('credentialId', credentialId);
      } else {
        localStorage.removeItem('credentialId');
      }
      this.updateCloudSyncButton();
    });

    // 添加云同步按钮事件监听
    cloudSyncBtnElement.addEventListener('click', async () => {
      const credentialId = credentialIdElement.value.trim();
      
      // 检查凭据ID
      if (!credentialId) {
        showToast('请输入个人凭据ID', 'error');
        return;
      }

      // 设置loading状态
      this.updateCloudSyncButton(true);

      try {
        if (!this.syncEnabled) {
          // 开启云同步
          await this.enableCloudSync(credentialId);
        } else {
          // 关闭云同步
          await this.disableCloudSync();
        }
      } catch (error) {
        console.error('云同步操作失败:', error);
        showToast('操作失败，请稍后重试', 'error');
      } finally {
        // 更新按钮状态
        this.updateCloudSyncButton();
      }
    });

    // 创建手动同步按钮
    const syncSettingsElement = cloudSyncBtnElement.parentElement;
    
    // 创建手动同步按钮
    const manualSyncBtn = document.createElement('button');
    manualSyncBtn.id = 'manualSyncBtn';
    manualSyncBtn.className = 'btn btn-secondary mt-2';
    manualSyncBtn.innerHTML = `
      <span class="relative flex items-center justify-center">
        <svg xmlns="http://www.w3.org/2000/svg" class="icon icon-tabler icon-tabler-cloud-download w-5 h-5 mr-2" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" fill="none" stroke-linecap="round" stroke-linejoin="round">
          <path stroke="none" d="M0 0h24v24H0z" fill="none"></path>
          <path d="M19 18a3.5 3.5 0 0 0 0 -7h-1a5 4.5 0 0 0 -11 -2a4.6 4.4 0 0 0 -2.1 8.4"></path>
          <path d="M12 13l0 9"></path>
          <path d="M9 19l3 3l3 -3"></path>
        </svg>
        <span class="btn-text">从云端同步到本地</span>
        <span id="manualSyncLoading" class="absolute right-2 -mt-1 hidden">
          <div class="w-4 h-4 border-2 border-t-2 border-gray-200 border-t-blue-500 rounded-full animate-spin"></div>
        </span>
      </span>
    `;
    
    // 添加手动同步按钮点击事件
    manualSyncBtn.addEventListener('click', async () => {
      // 检查凭据ID
      const credentialId = credentialIdElement.value.trim();
      if (!credentialId) {
        showToast('请输入个人凭据ID', 'error');
        return;
      }

      // 设置loading状态
      manualSyncBtn.disabled = true;
      document.getElementById('manualSyncLoading').classList.remove('hidden');
      this.updateSyncStatus('syncing');
      
      try {
        // 确保 WebDAV 客户端已初始化
        if (!this.webdavClient) {
          this.webdavClient = new WebDAVClient(credentialId);
        }
        
        // 测试连接
        const connected = await this.webdavClient.testConnection();
        if (!connected) {
          showToast('WebDAV 连接测试失败，请检查网络连接', 'error');
          this.updateSyncStatus('error');
          return;
        }
        
        // 从云端同步数据
        const success = await this.syncFromCloud();
        if (success) {
          this.updateSyncStatus('success');
          showToast('数据已从云端同步成功，即将刷新页面', 'success');
          
          // 刷新页面以应用更改
          setTimeout(() => {
            window.location.reload();
          }, 3000);
        } else {
          this.updateSyncStatus('error');
        }
      } catch (error) {
        console.error('手动同步失败:', error);
        showToast('同步失败，请稍后重试', 'error');
        this.updateSyncStatus('error');
      } finally {
        manualSyncBtn.disabled = false;
        document.getElementById('manualSyncLoading').classList.add('hidden');
      }
    });
    
    // 添加到DOM
    syncSettingsElement.appendChild(manualSyncBtn);
    
    // 初始显示状态
    manualSyncBtn.style.display = this.syncEnabled ? 'block' : 'none';
    
    // 保存引用以便后续更新
    this.manualSyncBtn = manualSyncBtn;
  }

  // 更新云同步按钮状态
  updateCloudSyncButton(isLoading = false) {
    // 如果不是设置页面，直接返回
    if (!this.isSettingsPage) {
      return;
    }
    
    const btn = document.getElementById('cloudSyncBtn');
    if (!btn) return;
    
    const btnText = btn.querySelector('.btn-text');
    const loadingIcon = document.getElementById('cloudSyncLoading');
    if (!btnText || !loadingIcon) return;
    
    const credentialIdElement = document.getElementById('credentialId');
    if (!credentialIdElement) return;
    
    const credentialId = credentialIdElement.value.trim();
    
    if (isLoading) {
      btn.disabled = true;
      loadingIcon.classList.remove('hidden');
      return;
    }

    loadingIcon.classList.add('hidden');
    
    if (!credentialId) {
      btn.disabled = true;
      btnText.textContent = '开启云同步';
      // 隐藏手动同步按钮
      if (this.manualSyncBtn) {
        this.manualSyncBtn.style.display = 'none';
      }
      return;
    }

    if (this.syncEnabled) {
      btn.disabled = false;
      btnText.textContent = '关闭云同步';
      // 显示手动同步按钮
      if (this.manualSyncBtn) {
        this.manualSyncBtn.style.display = 'block';
      }
    } else {
      btn.disabled = false;
      btnText.textContent = '开启云同步';
      // 隐藏手动同步按钮
      if (this.manualSyncBtn) {
        this.manualSyncBtn.style.display = 'none';
      }
    }
  }

  // 初始化同步状态图标
  initSyncStatusIcon() {
    try {
      // 检查是否已存在同步状态图标
      if (document.getElementById('syncStatusIcon')) {
        this.syncStatusIcon = document.getElementById('syncStatusIcon');
        return;
      }
      
      // 创建同步状态图标
      this.syncStatusIcon = document.createElement('div');
      this.syncStatusIcon.id = 'syncStatusIcon';
      this.syncStatusIcon.className = 'fixed bottom-4 right-4 p-2 rounded-full bg-gray-800 text-white opacity-0 transition-opacity duration-300';
      this.syncStatusIcon.innerHTML = '🔄';
      this.syncStatusIcon.style.zIndex = '1000';
      
      // 确保body元素已加载
      if (document.body) {
        document.body.appendChild(this.syncStatusIcon);
      } else {
        // 如果body还未加载完成，等待DOMContentLoaded事件
        document.addEventListener('DOMContentLoaded', () => {
          document.body.appendChild(this.syncStatusIcon);
        });
      }
    } catch (error) {
      console.error('初始化同步状态图标失败:', error);
    }
  }

  // 更新同步状态图标
  updateSyncStatus(status) {
    if (!this.syncStatusIcon) return;

    switch (status) {
      case 'syncing':
        this.syncStatusIcon.style.opacity = '1';
        this.syncStatusIcon.style.animation = 'spin 2s linear infinite';
        break;
      case 'success':
        this.syncStatusIcon.style.opacity = '1';
        this.syncStatusIcon.style.animation = 'none';
        this.syncStatusIcon.innerHTML = '✅';
        setTimeout(() => {
          if (this.syncStatusIcon) {
            this.syncStatusIcon.style.opacity = '0';
          }
        }, 2000);
        break;
      case 'error':
        this.syncStatusIcon.style.opacity = '1';
        this.syncStatusIcon.style.animation = 'none';
        this.syncStatusIcon.innerHTML = '❌';
        setTimeout(() => {
          if (this.syncStatusIcon) {
            this.syncStatusIcon.style.opacity = '0';
          }
        }, 2000);
        break;
      default:
        this.syncStatusIcon.style.opacity = '0';
        this.syncStatusIcon.style.animation = 'none';
    }
  }

  // 防抖处理同步
  debouncedSync() {
    // 检查实例是否已禁用
    if (this.isDisabled) return;
    
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }

    // 移除时间间隔检查，只保留数据变化检测
    this.syncDebounceTimer = setTimeout(async () => {
      if (this.syncInProgress) {
        console.log('同步操作正在进行中，跳过此次同步');
        return;
      }
      
      // 检查页面是否活跃
      if (!this.isPageActive) {
        console.log('页面不活跃，跳过同步');
        return;
      }
      
      // 检查数据是否有变化
      if (!this.hasDataChanged()) {
        console.log('本地数据未发生变化，跳过同步');
        return;
      }
      
      // 尝试获取同步锁
      const lockAcquired = await this.acquireSyncLock();
      if (!lockAcquired) {
        console.log('无法获取同步锁，跳过同步');
        return;
      }
      
      try {
        this.syncInProgress = true;
        this.updateSyncStatus('syncing');
        
        // 确保 WebDAV 客户端已初始化
        if (!this.webdavClient && this.credentialId) {
          this.webdavClient = new WebDAVClient(this.credentialId);
        }

        const success = await this.syncToCloud(false); // 手动同步
        if (success) {
          this.updateSyncStatus('success');
          
          // 更新数据快照
          this.updateDataSnapshot();
          
          // 广播同步完成消息
          this.syncChannel.postMessage({
            type: 'syncComplete',
            pageId: this.pageId,
            lastSyncTime: this.lastSyncTime
          });
        } else {
          this.updateSyncStatus('error');
        }
      } catch (error) {
        console.error('同步失败:', error);
        this.updateSyncStatus('error');
        
        // 显示Toast提示，不再检查页面类型
        showToast('同步到云端失败，请稍后重试', 'error');
      } finally {
        this.syncInProgress = false;
        // 释放同步锁
        this.releaseSyncLock();
      }
    }, 5000); // 增加到5秒防抖延迟，给用户更多时间批量操作
  }

  // 检查数据是否有变化
  hasDataChanged() {
    // 如果是首次同步，没有上次同步的数据快照
    if (!this.lastSyncDataSnapshot) {
      this.updateDataSnapshot(); // 初始化数据快照
      console.log('首次同步，已创建数据快照');
      return false; // 首次不需要同步，等待真正的数据变化
    }
    
    // 获取当前数据
    const currentData = this.getAllLocalStorageData();
    
    // 比较数据
    const currentDataKeys = Object.keys(currentData);
    const lastDataKeys = Object.keys(this.lastSyncDataSnapshot);
    
    // 如果键的数量不同，说明有变化
    if (currentDataKeys.length !== lastDataKeys.length) {
      console.log(`数据键数量发生变化，从 ${lastDataKeys.length} 变为 ${currentDataKeys.length}`);
      return true;
    }
    
    // 比较每个键的值
    let hasChanges = false;
    let changedKeys = [];
    
    // 定义重要键列表 - 这些键的变化会立即触发同步
    const importantKeys = [
      'currentPlayingId',  // 当前播放ID
      'selectedAPIs',      // 选中的API
      'yellowFilterEnabled', // 黄色内容过滤设置
      'adFilteringEnabled'   // 广告过滤设置
    ];
    
    for (const key of currentDataKeys) {
      // 检查键值是否变化
      if (currentData[key] !== this.lastSyncDataSnapshot[key]) {
        changedKeys.push(key);
        
        // 特殊处理观看历史
        if (key === 'viewingHistory') {
          try {
            // 尝试解析观看历史数据
            const currentHistory = JSON.parse(currentData[key] || '[]');
            const lastHistory = JSON.parse(this.lastSyncDataSnapshot[key] || '[]');
            
            // 如果记录数量不同，需要同步
            if (currentHistory.length !== lastHistory.length) {
              console.log(`观看历史记录数量变化，需要同步`);
              return true;
            }
            
            // 检查是否只有最近的记录发生了变化
            if (currentHistory.length > 0 && lastHistory.length > 0) {
              // 比较每条记录的关键信息（不比较进度）
              let hasStructuralChanges = false;
              
              for (let i = 0; i < currentHistory.length; i++) {
                const currentItem = currentHistory[i];
                const lastItem = lastHistory[i];
                
                // 比较关键标识符，忽略进度变化
                if (currentItem.showIdentifier !== lastItem.showIdentifier ||
                    currentItem.episodeIndex !== lastItem.episodeIndex ||
                    currentItem.url !== lastItem.url) {
                  console.log(`观看历史第${i+1}条记录的剧集信息已变化，需要同步`);
                  hasStructuralChanges = true;
                  break;
                }
              }
              
              if (hasStructuralChanges) {
                return true;
              }
            }
            
            // 如果只是进度变化，不触发同步
            console.log(`观看历史仅有播放进度变化，不触发同步`);
            changedKeys.pop(); // 从变化列表中移除
            continue;
            
          } catch (e) {
            console.error(`解析观看历史数据失败:`, e);
            // 解析失败时，保守处理，同步变化
            return true;
          }
        }
        
        // 检查是否是重要键或其前缀
        const isImportantKey = importantKeys.some(importantKey => 
          key === importantKey || key.startsWith(importantKey)
        );
        
        if (isImportantKey) {
          console.log(`检测到重要键 ${key} 的值发生变化，需立即同步`);
          return true; // 重要键变化立即返回true
        }
        
        hasChanges = true;
      }
    }
    
    if (hasChanges) {
      console.log(`检测到数据变化，变化的键: ${changedKeys.join(', ')}`);
      return true;
    }
    
    console.log('数据没有变化，不需要同步');
    return false;
  }
  
  // 更新数据快照
  updateDataSnapshot() {
    this.lastSyncDataSnapshot = this.getAllLocalStorageData();
    console.log('数据快照已更新');
  }

  // 处理 localStorage 变化
  handleStorageChange(event) {
    // 检查实例是否已禁用
    if (this.isDisabled) return;
    
    // 如果正在从云端同步到本地，则不处理本地数据变化
    if (this.isSyncingFromCloud || !this.syncEnabled) return;

    // 检查是否是黑名单中的键
    if (this.isBlacklistedKey(event.key)) return;
    
    // 忽略lastSyncTime的变化，避免循环触发
    if (event.key === 'lastSyncTime') return;
    
    // 增加对syncLock相关键的忽略
    if (event.key === SYNC_LOCK_CONFIG.lockKey || event.key === SYNC_LOCK_CONFIG.lockTimeKey) return;

    // 节流控制 - 检查上次处理同一个键的时间
    const now = Date.now();
    const lastHandledTime = this.lastHandledKeys[event.key] || 0;
    
    // 如果同一个键在短时间内频繁变化，只处理一次
    if (now - lastHandledTime < this.storageEventThrottleDelay) {
      // 对于viewingHistory键，总是忽略频繁变化
      if (event.key === 'viewingHistory') {
        this.ignoredEventCount++;
        // 每忽略10次事件，记录一次日志
        if (this.ignoredEventCount % 10 === 0) {
          console.log(`已忽略${this.ignoredEventCount}次频繁的viewingHistory变化事件`);
        }
        return;
      }
      
      // 对于其他键，也进行节流，但阈值可以更低
      if (now - lastHandledTime < 1000) { // 其他键1秒内只处理一次
        console.log(`忽略键${event.key}的频繁变化事件，与上次处理间隔: ${now - lastHandledTime}ms`);
        return;
      }
    }
    
    // 更新该键最后处理时间
    this.lastHandledKeys[event.key] = now;
    
    console.log(`检测到键 ${event.key} 变化，准备同步`);

    // 确保 WebDAV 客户端已初始化
    if (!this.webdavClient && this.credentialId) {
      this.webdavClient = new WebDAVClient(this.credentialId);
    }

    // 使用防抖处理同步
    this.debouncedSync();
  }

  // 检查键是否在黑名单中
  isBlacklistedKey(key) {
    // 直接检查是否在黑名单列表中
    if (SYNC_BLACKLIST.includes(key)) return true;
    
    // 检查前缀
    for (const prefix of SYNC_BLACKLIST_PREFIXES) {
      if (key.startsWith(prefix)) return true;
    }
    
    return false;
  }

  // 添加样式到页面
  addStyles() {
    const style = document.createElement('style');
    style.textContent = `
      @keyframes spin {
        from { transform: rotate(0deg); }
        to { transform: rotate(360deg); }
      }
      #syncStatusIcon {
        cursor: pointer;
        user-select: none;
      }
      
      /* 手动同步按钮样式 */
      #manualSyncBtn {
        width: 100%;
        margin-top: 8px;
        background-color: #4f46e5;
        border: none;
        color: white;
        padding: 8px 12px;
        border-radius: 6px;
        transition: all 0.3s ease;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 8px;
        box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
      }
      
      #manualSyncBtn:hover {
        background-color: #4338ca;
        transform: translateY(-1px);
        box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
      }
      
      #manualSyncBtn:disabled {
        background-color: #6b7280;
        cursor: not-allowed;
        transform: none;
        box-shadow: none;
      }
      
      #manualSyncBtn .icon {
        flex-shrink: 0;
      }
      
      /* 公告栏样式 */
      .announcement-modal {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 9999;
        opacity: 0;
        transition: opacity 0.3s ease;
        pointer-events: none;
      }
      
      .announcement-modal.show {
        opacity: 1;
        pointer-events: auto;
      }
      
      .announcement-container {
        background-color: #111;
        border: 1px solid #333;
        border-radius: 8px;
        padding: 20px;
        max-width: 90%;
        width: 500px;
        max-height: 80vh;
        overflow-y: auto;
        position: relative;
        box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
      }
      
      .announcement-title {
        font-size: 1.5rem;
        margin-bottom: 15px;
        color: white;
        text-align: center;
        background: linear-gradient(to right, #4f46e5, #9333ea, #ec4899);
        -webkit-background-clip: text;
        -webkit-text-fill-color: transparent;
        font-weight: bold;
      }
      
      .announcement-content {
        color: #e0e0e0;
        line-height: 1.6;
        margin-bottom: 20px;
        white-space: pre-line;
      }
      
      .announcement-close {
        display: block;
        margin: 0 auto;
        padding: 8px 16px;
        background: linear-gradient(to right, #4f46e5, #9333ea, #ec4899);
        color: white;
        border: none;
        border-radius: 4px;
        cursor: pointer;
        transition: all 0.3s ease;
      }
      
      .announcement-close:hover {
        transform: translateY(-2px);
        box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
      }
    `;
    document.head.appendChild(style);
  }

  // 同步管理器初始化
  async init(credentialId) {
    if (!credentialId) {
      console.error('初始化失败: 凭据ID为空');
      return false;
    }
    
    try {
      this.credentialId = credentialId;
      this.webdavClient = new WebDAVClient(credentialId);
      
      // 测试连接
      const connected = await this.webdavClient.testConnection();
      if (!connected) {
        console.error('初始化失败: WebDAV 连接测试失败');
        this.syncEnabled = false;
        localStorage.setItem('cloudSyncEnabled', 'false');
        return false;
      }
      
      console.log('WebDAV 客户端初始化成功');
      return true;
    } catch (error) {
      console.error('初始化过程发生错误:', error);
      return false;
    }
  }

  // 同步到云端
  async syncToCloud(isAutoSync = false) {
    // 检查实例是否已禁用
    if (this.isDisabled) return false;
    
    if (!this.syncEnabled || !this.webdavClient) {
      console.error('同步失败: 同步未启用或 WebDAV 客户端未初始化');
      return false;
    }

    try {
      // 检查页面是否活跃
      if (!this.isPageActive) {
        console.log('页面不活跃，跳过同步');
        return false;
      }
      
      // 确保持有同步锁
      if (!this.isHoldingLock()) {
        console.log('未持有同步锁，尝试获取');
        const lockAcquired = await this.acquireSyncLock();
        if (!lockAcquired) {
          console.log('无法获取同步锁，跳过同步');
          return false;
        }
      }

      console.log('开始执行同步到云端操作');
      
      // 显示开始同步的提示
      showToast(isAutoSync ? '检测到数据变化，正在自动同步到云端...' : '正在同步数据到云端...', 'info');
      
      // 先测试连接
      console.log('测试 WebDAV 连接...');
      const connected = await this.webdavClient.testConnection();
      if (!connected) {
        console.error('同步失败: WebDAV 连接测试失败');
        showToast('WebDAV连接失败，请检查网络', 'error');
        return false;
      }
      console.log('WebDAV 连接测试成功');

      // 获取所有需要同步的数据
      console.log('获取本地数据...');
      const localData = {
        data: this.getAllLocalStorageData(),
        timestamp: Date.now(),
        credentialId: this.credentialId
      };

      console.log('准备同步的完整数据:', localData);

      // 上传本地数据
      console.log('开始上传数据到云端...');
      const success = await this.webdavClient.uploadData(localData);
      if (success) {
        this.lastSyncTime = Date.now();
        localStorage.setItem('lastSyncTime', this.lastSyncTime);
        console.log('同步成功，时间戳:', this.lastSyncTime);
        
        // 更新数据快照
        this.updateDataSnapshot();
        
        // 无论是自动还是手动同步，都显示成功提示
        showToast(isAutoSync ? '数据已自动同步到云端' : '数据已成功同步到云端', 'success');
        
        return true;
      }

      console.error('同步失败: 上传数据失败');
      // 无论是自动还是手动同步，都显示失败提示
      showToast('同步到云端失败，请检查网络连接', 'error');
      return false;
    } catch (error) {
      console.error('同步过程发生错误:', error);
      // 无论是自动还是手动同步，都显示错误提示
      showToast('同步到云端失败，请稍后重试', 'error');
      return false;
    } finally {
      // 如果是由此方法获取的锁，则释放
      if (this.isHoldingLock()) {
        console.log('同步完成，释放同步锁');
        this.releaseSyncLock();
      }
    }
  }

  // 从云端同步数据到本地的共通方法
  async syncDataFromCloudToLocal(cloudData, showSuccessMessage = true) {
    if (!cloudData) {
      console.log('云端暂无数据');
      showToast('云端暂无数据', 'warning');
      return false;
    }

    // 验证云端数据
    if (!this.validateCloudData(cloudData)) {
      console.error('从云端同步失败: 数据格式无效');
      showToast('云端数据格式无效', 'error');
      return false;
    }

    if (cloudData.credentialId !== this.credentialId) {
      console.error('从云端同步失败: 凭据ID不匹配');
      showToast('云端数据与当前凭据ID不匹配', 'error');
      return false;
    }

    // 显示同步中的提示，不再检查页面类型
    showToast('正在从云端同步数据...', 'info');

    // 设置同步标志
    this.isSyncingFromCloud = true;

    try {
      // 应用云端数据
      if (cloudData.data) {
        console.log('正在应用云端数据...');
        this.applyCloudData(cloudData.data);
      }
      
      this.lastSyncTime = Date.now();
      localStorage.setItem('lastSyncTime', this.lastSyncTime);
      
      // 更新数据快照
      this.updateDataSnapshot();
      
      console.log('从云端同步成功，时间戳:', this.lastSyncTime);
      if (showSuccessMessage) {
        showToast('数据已从云端同步成功', 'success');
      }
      return true;
    } finally {
      // 清除同步标志
      this.isSyncingFromCloud = false;
    }
  }

  // 从云端同步
  async syncFromCloud() {
    // 检查实例是否已禁用
    if (this.isDisabled) return false;
    
    if (!this.webdavClient) {
      console.error('从云端同步失败: WebDAV 客户端未初始化');
      showToast('WebDAV 客户端未初始化，请确保已正确设置凭据ID', 'error');
      return false;
    }

    try {
      // 检查页面是否活跃
      if (!this.isPageActive) {
        console.log('页面不活跃，跳过从云端同步');
        return false;
      }
      
      // 尝试获取同步锁
      const lockAcquired = await this.acquireSyncLock();
      if (!lockAcquired) {
        console.log('无法获取同步锁，跳过从云端同步');
        return false;
      }

      // 先测试连接
      const connected = await this.webdavClient.testConnection();
      if (!connected) {
        console.error('从云端同步失败: WebDAV 连接测试失败');
        showToast('WebDAV 连接测试失败，请检查网络连接', 'error');
        return false;
      }

      // 从云端下载数据
      const cloudData = await this.webdavClient.downloadData();
      
      // 使用共通方法处理云端数据同步到本地
      return await this.syncDataFromCloudToLocal(cloudData);
    } catch (error) {
      console.error('从云端同步过程发生错误:', error);
      showToast('从云端同步失败，请稍后重试', 'error');
      return false;
    } finally {
      // 释放同步锁
      if (this.isHoldingLock()) {
        this.releaseSyncLock();
      }
    }
  }

  // 验证云端数据格式
  validateCloudData(data) {
    if (!data || typeof data !== 'object') {
      console.error('云端数据无效: 不是有效的对象');
      return false;
    }

    if (!data.credentialId || typeof data.credentialId !== 'string') {
      console.error('云端数据无效: 缺少凭据ID或格式错误');
      return false;
    }

    if (!data.timestamp || typeof data.timestamp !== 'number') {
      console.error('云端数据无效: 缺少时间戳或格式错误');
      return false;
    }

    if (!data.data || typeof data.data !== 'object') {
      console.error('云端数据无效: 缺少数据字段或格式错误');
      return false;
    }

    return true;
  }

  // 获取所有需要同步的 localStorage 数据
  getAllLocalStorageData() {
    const data = {};
    
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      
      // 跳过黑名单中的键
      if (this.isBlacklistedKey(key)) continue;
      
      try {
        data[key] = localStorage.getItem(key);
      } catch (e) {
        console.error('获取 localStorage 项目失败:', key, e);
      }
    }
    
    return data;
  }

  // 应用云端数据到本地
  applyCloudData(cloudData) {
    if (!cloudData || typeof cloudData !== 'object') {
      console.error('应用云端数据失败: 数据格式无效');
      return false;
    }
    
    try {
      // 保存当前黑名单中的项目值
      const blacklistValues = {};
      for (const key of SYNC_BLACKLIST) {
        if (localStorage.getItem(key) !== null) {
          blacklistValues[key] = localStorage.getItem(key);
        }
      }
      
      // 应用云端数据到本地
      let appliedCount = 0;
      for (const [key, value] of Object.entries(cloudData)) {
        // 跳过黑名单中的键（额外保护措施）
        if (this.isBlacklistedKey(key)) continue;
        
        try {
          localStorage.setItem(key, value);
          appliedCount++;
        } catch (e) {
          console.error('设置 localStorage 项目失败:', key, e);
        }
      }
      
      console.log(`已成功应用 ${appliedCount} 项云端数据`);
      
      // 恢复黑名单项目
      for (const [key, value] of Object.entries(blacklistValues)) {
        localStorage.setItem(key, value);
      }
      
      // 触发 UI 更新事件
      this.triggerUIUpdates();
      
      return true;
    } catch (error) {
      console.error('应用云端数据时发生错误:', error);
      return false;
    }
  }

  // 触发 UI 更新
  triggerUIUpdates() {
    // 更新 API 复选框
    if (typeof initAPICheckboxes === 'function') {
      initAPICheckboxes();
    }
    
    // 更新自定义 API 列表
    if (typeof renderCustomAPIsList === 'function') {
      renderCustomAPIsList();
    }
    
    // 更新选中的 API 数量
    if (typeof updateSelectedApiCount === 'function') {
      updateSelectedApiCount();
    }
    
    // 更新黄色内容过滤开关
    const yellowFilterToggle = document.getElementById('yellowFilterToggle');
    if (yellowFilterToggle) {
      yellowFilterToggle.checked = localStorage.getItem('yellowFilterEnabled') === 'true';
    }

    // 更新广告过滤开关
    const adFilterToggle = document.getElementById('adFilterToggle');
    if (adFilterToggle) {
      adFilterToggle.checked = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) === 'true';
    }
    
    // 更新自动播放开关
    const autoplayToggle = document.getElementById('autoplayToggle');
    if (autoplayToggle) {
      autoplayToggle.checked = localStorage.getItem('autoplayEnabled') === 'true';
    }
    
    // 触发设置更新事件
    document.dispatchEvent(new CustomEvent('settingsUpdated'));
  }

  // 启动自动同步
  startAutoSync() {
    // 检查实例是否已禁用
    if (this.isDisabled) return;
    
    this.stopAutoSync(); // 先停止现有的定时器
    
    // 创建初始数据快照
    this.updateDataSnapshot();
    console.log('已创建初始数据快照，自动同步已启动');
    
    this.autoSyncTimer = setInterval(async () => {
      if (!this.syncEnabled) {
        console.log('自动同步已禁用');
        return;
      }
      
      if (!this.isPageActive) {
        console.log('页面不活跃，跳过自动同步');
        return;
      }
      
      // 检查数据是否有变化
      if (!this.hasDataChanged()) {
        console.log('定时同步：数据未变化，跳过同步');
        return;
      }
      
      console.log('定时同步：检测到数据变化，开始同步');
      
      // 显示同步状态图标
      this.updateSyncStatus('syncing');
      
      // 尝试获取同步锁
      const lockAcquired = await this.acquireSyncLock();
      if (lockAcquired) {
        try {
          const success = await this.syncToCloud(true); // 自动同步，使用特定提示
          if (success) {
            this.updateSyncStatus('success');
          } else {
            this.updateSyncStatus('error');
          }
        } finally {
          // 释放同步锁
          this.releaseSyncLock();
        }
      } else {
        console.log('定时同步：无法获取同步锁，跳过同步');
        this.updateSyncStatus('error');
      }
    }, this.syncInterval);
  }

  // 停止自动同步
  stopAutoSync() {
    if (this.autoSyncTimer) {
      clearInterval(this.autoSyncTimer);
      this.autoSyncTimer = null;
    }
  }

  // 开启云同步
  async enableCloudSync(credentialId) {
    try {
      // 检查页面是否活跃
      if (!this.isPageActive) {
        console.log('页面不活跃，跳过开启云同步');
        showToast('当前页面不活跃，请在活跃页面操作', 'warning');
        return;
      }
      
      // 尝试获取同步锁
      const lockAcquired = await this.acquireSyncLock();
      if (!lockAcquired) {
        console.log('无法获取同步锁，跳过开启云同步');
        showToast('其他页面正在执行同步操作，请稍后再试', 'warning');
        return;
      }

      try {
        console.log('开始初始化WebDAV客户端...');
        // 1. 初始化WebDAV客户端
        const initSuccess = await this.init(credentialId);
        if (!initSuccess) {
          showToast('WebDAV 连接失败，请检查凭据ID', 'error');
          return;
        }
        console.log('WebDAV客户端初始化成功');

        // 2. 检查云端数据
        console.log('检查云端数据...');
        const cloudData = await this.webdavClient.downloadData();
        
        // 3. 先启用同步设置
        this.syncEnabled = true;
        localStorage.setItem('cloudSyncEnabled', 'true');
        localStorage.setItem('credentialId', this.credentialId);
        console.log('云同步设置已启用');

        if (cloudData) {
          console.log('云端存在数据，尝试同步到本地...');
          // 使用共通方法处理云端数据同步到本地
          const syncSuccess = await this.syncDataFromCloudToLocal(cloudData, false);
          
          if (syncSuccess) {
            showToast('云同步已开启，数据已从云端同步', 'success');
            
            // 刷新整个页面
            setTimeout(() => {
              window.location.reload();
            }, 3000); // 延迟3秒后刷新，让用户看到成功提示
          } else {
            showToast('云同步已开启，但从云端同步数据失败', 'warning');
          }
        } else {
          console.log('云端没有数据，准备上传本地数据...');
          // 云端没有数据，同步本地数据到云端
          // 先创建数据快照
          this.updateDataSnapshot();
          
          const localData = {
            data: this.getAllLocalStorageData(),
            timestamp: Date.now(),
            credentialId: this.credentialId
          };

          console.log('准备上传本地数据到云端...');
          const uploadSuccess = await this.webdavClient.uploadData(localData);
          if (uploadSuccess) {
            this.lastSyncTime = Date.now();
            localStorage.setItem('lastSyncTime', this.lastSyncTime);
            showToast('云同步已开启，本地数据已同步到云端', 'success');
          } else {
            showToast('云同步已开启，但同步到云端失败', 'warning');
          }
        }

        // 启动定时同步
        this.startAutoSync();
        console.log('自动同步已启动');
      } finally {
        // 释放同步锁
        this.releaseSyncLock();
      }
    } catch (error) {
      console.error('开启云同步失败:', error);
      throw error;
    }
  }

  // 关闭云同步
  async disableCloudSync() {
    try {
      // 停用同步功能
      this.syncEnabled = false;
      localStorage.setItem('cloudSyncEnabled', 'false');
      // 停止自动同步
      this.stopAutoSync();
      showToast('云同步已关闭', 'info');
    } catch (error) {
      console.error('关闭云同步失败:', error);
      throw error;
    }
  }

  // 检查公告
  async checkAnnouncement() {
    try {
      // 检查上次检查时间
      const lastCheckTime = parseInt(localStorage.getItem(ANNOUNCEMENT_CONFIG.checkTimeKey) || '0');
      const now = Date.now();
      
      // 如果距离上次检查不到24小时，则跳过
      if (now - lastCheckTime < ANNOUNCEMENT_CONFIG.checkInterval) {
        console.log('距离上次检查公告时间不足24小时，跳过检查');
        return;
      }
      
      // 更新检查时间
      localStorage.setItem(ANNOUNCEMENT_CONFIG.checkTimeKey, now.toString());
      
      // 获取公告内容
      console.log('正在获取公告内容...');
      const response = await fetch(ANNOUNCEMENT_CONFIG.url);
      if (!response.ok) {
        console.error('获取公告失败:', response.status, await response.text());
        
        // 如果是401错误，可能是签名过期，记录详细信息
        if (response.status === 401) {
          console.error('授权错误，可能是签名已过期，请更新签名');
        }
        return;
      }
      
      // 获取纯文本内容
      const announcementText = await response.text();
      console.log('获取到公告内容:', announcementText.substring(0, 50) + (announcementText.length > 50 ? '...' : ''));
      
      if (!announcementText || announcementText.trim() === '') {
        console.log('公告内容为空');
        return;
      }
      
      // 计算公告内容的哈希作为ID
      const announcementId = await this.hashString(announcementText);
      
      // 检查是否已经显示过该公告
      const lastAnnouncementId = localStorage.getItem(ANNOUNCEMENT_CONFIG.storageKey);
      if (lastAnnouncementId === announcementId) {
        console.log('该公告已显示过');
        return;
      }
      
      // 显示公告
      this.showAnnouncement(announcementText, announcementId);
      
    } catch (error) {
      console.error('检查公告时出错:', error);
    }
  }
  
  // 计算字符串的哈希值
  async hashString(str) {
    // 使用简单的哈希算法
    if (window._jsSha256) {
      return window._jsSha256(str);
    }
    
    // 如果没有sha256库，使用简单的哈希函数
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32bit integer
    }
    return hash.toString(16);
  }
  
  // 显示公告
  showAnnouncement(content, announcementId) {
    // 创建公告模态框
    const modal = document.createElement('div');
    modal.className = 'announcement-modal';
    
    modal.innerHTML = `
      <div class="announcement-container">
        <h3 class="announcement-title">LibreTV 公告</h3>
        <div class="announcement-content">${this.formatAnnouncementContent(content)}</div>
        <button class="announcement-close">我知道了</button>
      </div>
    `;
    
    // 添加到页面
    document.body.appendChild(modal);
    
    // 显示模态框
    setTimeout(() => {
      modal.classList.add('show');
    }, 100);
    
    // 添加关闭按钮事件
    const closeButton = modal.querySelector('.announcement-close');
    closeButton.addEventListener('click', () => {
      modal.classList.remove('show');
      setTimeout(() => {
        modal.remove();
      }, 300);
      
      // 保存已显示的公告ID
      localStorage.setItem(ANNOUNCEMENT_CONFIG.storageKey, announcementId);
    });
  }
  
  // 格式化公告内容
  formatAnnouncementContent(content) {
    // 处理换行符
    let formatted = content.replace(/\n/g, '<br>');
    
    // 处理链接
    formatted = formatted.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" style="color:#4f46e5;text-decoration:underline;">$1</a>');
    
    return formatted;
  }

  // 设置定期清理
  setupPeriodicCleanup() {
    if (this.isDisabled) return;
    
    // 每小时清理一次
    setInterval(() => {
      if (!this.isPageActive) return;
      
      // 清理节流控制记录
      console.log('执行定期清理任务...');
      this.lastHandledKeys = {};
      this.ignoredEventCount = 0;
      
      // 检查并清理过期锁
      this.checkAndClearExpiredLock();
      
      console.log('定期清理任务完成');
    }, 60 * 60 * 1000); // 1小时
  }
}

// 创建全局同步管理器实例
// 修改为在DOM加载完成后初始化
function initGlobalSyncManager() {
  try {
    if (window.syncManager) {
      console.log('SyncManager已初始化，跳过重复初始化');
      return;
    }
    
    // 检查是否是顶层窗口
    const isTopWindow = window.self === window.top;
    // 如果是在iframe中运行，且不是设置页面，则不初始化同步管理器
    if (!isTopWindow) {
      const currentPath = window.location.pathname;
      // 只允许主页面或设置页面初始化
      if (!(currentPath === '/' || currentPath.endsWith('/index.html'))) {
        console.log('当前页面在iframe中且非主页面，跳过SyncManager初始化');
        return;
      }
    }
    
    window.syncManager = new SyncManager();
    console.log('全局SyncManager初始化完成');
  } catch (error) {
    console.error('初始化SyncManager时发生错误:', error);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initGlobalSyncManager);
} else {
  // 如果DOM已经加载完成，直接初始化
  initGlobalSyncManager();
} 