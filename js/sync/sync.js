// WebDAV 默认配置
const DEFAULT_WEBDAV_CONFIG = {
  url: 'https://alist.10023456.xyz/dav',
  username: 'webdav',
  password: 'webdav'
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
      // 1. 测试基本连接
      const basicTest = await fetch(this.config.url, {
        method: 'PROPFIND',
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.config.username}:${this.config.password}`),
          'Depth': '0'
        }
      });

      if (!basicTest.ok) {
        console.error('WebDAV 基本连接测试失败:', basicTest.status);
        return false;
      }

      // 2. 测试文件操作权限
      const testFileName = `test_${Date.now()}.txt`;
      const testContent = 'test';
      
      // 尝试创建测试文件
      const createTest = await fetch(`${this.config.url}/${testFileName}`, {
        method: 'PUT',
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.config.username}:${this.config.password}`),
          'Content-Type': 'text/plain'
        },
        body: testContent
      });

      if (!createTest.ok) {
        console.error('WebDAV 写入权限测试失败:', createTest.status);
        return false;
      }

      // 尝试读取测试文件
      const readTest = await fetch(`${this.config.url}/${testFileName}`, {
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.config.username}:${this.config.password}`)
        }
      });

      if (!readTest.ok) {
        console.error('WebDAV 读取权限测试失败:', readTest.status);
        return false;
      }

      // 尝试删除测试文件
      const deleteTest = await fetch(`${this.config.url}/${testFileName}`, {
        method: 'DELETE',
        headers: {
          'Authorization': 'Basic ' + btoa(`${this.config.username}:${this.config.password}`)
        }
      });

      if (!deleteTest.ok) {
        console.error('WebDAV 删除权限测试失败:', deleteTest.status);
        return false;
      }

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
    this.syncEnabled = localStorage.getItem('cloudSyncEnabled') === 'true';
    this.isSyncingFromCloud = false;
    this.webdavClient = null;
    this.credentialId = localStorage.getItem('credentialId') || '';
    this.lastSyncTime = localStorage.getItem('lastSyncTime') || 0;
    this.syncInterval = 30 * 60 * 1000; // 30分钟同步一次
    this.syncDebounceTimer = null;
    this.syncInProgress = false;
    this.syncStatusIcon = null;
    this.isManualSync = false;

    // 初始化
    this.initSyncStatusIcon();
    this.addStyles();
    this.setupEventListeners();
    this.initUI();
  }

  // 设置事件监听器
  setupEventListeners() {
    // 监听 localStorage 变化
    window.addEventListener('storage', this.handleStorageChange.bind(this));
    
    // 重写 localStorage 的 setItem 方法
    const originalSetItem = localStorage.setItem;
    localStorage.setItem = (key, value) => {
      // 调用原始的 setItem 方法
      originalSetItem.call(localStorage, key, value);
      
      // 创建自定义事件
      const event = new StorageEvent('storage', {
        key: key,
        newValue: value,
        oldValue: localStorage.getItem(key),
        storageArea: localStorage,
        url: window.location.href
      });
      
      // 触发事件
      window.dispatchEvent(event);
    };
  }

  // 初始化UI
  initUI() {
    // 初始化云同步设置
    const credentialId = localStorage.getItem('credentialId');
    if (credentialId) {
      document.getElementById('credentialId').value = credentialId;
    }

    // 初始化按钮状态
    this.updateCloudSyncButton();

    // 添加凭据ID输入框的事件监听
    document.getElementById('credentialId').addEventListener('input', (e) => {
      const credentialId = e.target.value.trim();
      if (credentialId) {
        localStorage.setItem('credentialId', credentialId);
      } else {
        localStorage.removeItem('credentialId');
      }
      this.updateCloudSyncButton();
    });

    // 添加云同步按钮事件监听
    document.getElementById('cloudSyncBtn').addEventListener('click', async () => {
      const credentialId = document.getElementById('credentialId').value.trim();
      
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
  }

  // 更新云同步按钮状态
  updateCloudSyncButton(isLoading = false) {
    const btn = document.getElementById('cloudSyncBtn');
    const btnText = btn.querySelector('.btn-text');
    const loadingIcon = document.getElementById('cloudSyncLoading');
    const credentialId = document.getElementById('credentialId').value.trim();
    
    if (isLoading) {
      btn.disabled = true;
      loadingIcon.classList.remove('hidden');
      return;
    }

    loadingIcon.classList.add('hidden');
    
    if (!credentialId) {
      btn.disabled = true;
      btnText.textContent = '开启云同步';
      return;
    }

    if (this.syncEnabled) {
      btn.disabled = false;
      btnText.textContent = '关闭云同步';
    } else {
      btn.disabled = false;
      btnText.textContent = '开启云同步';
    }
  }

  // 初始化同步状态图标
  initSyncStatusIcon() {
    // 创建同步状态图标
    this.syncStatusIcon = document.createElement('div');
    this.syncStatusIcon.id = 'syncStatusIcon';
    this.syncStatusIcon.className = 'fixed bottom-4 right-4 p-2 rounded-full bg-gray-800 text-white opacity-0 transition-opacity duration-300';
    this.syncStatusIcon.innerHTML = '🔄';
    this.syncStatusIcon.style.zIndex = '1000';
    document.body.appendChild(this.syncStatusIcon);
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
          this.syncStatusIcon.style.opacity = '0';
        }, 2000);
        break;
      case 'error':
        this.syncStatusIcon.style.opacity = '1';
        this.syncStatusIcon.style.animation = 'none';
        this.syncStatusIcon.innerHTML = '❌';
        setTimeout(() => {
          this.syncStatusIcon.style.opacity = '0';
        }, 2000);
        break;
      default:
        this.syncStatusIcon.style.opacity = '0';
        this.syncStatusIcon.style.animation = 'none';
    }
  }

  // 防抖处理同步
  debouncedSync() {
    if (this.syncDebounceTimer) {
      clearTimeout(this.syncDebounceTimer);
    }

    this.syncDebounceTimer = setTimeout(async () => {
      if (this.syncInProgress) return;
      
      this.syncInProgress = true;
      this.updateSyncStatus('syncing');
      showToast('正在同步数据到云端...', 'info');

      try {
        // 确保 WebDAV 客户端已初始化
        if (!this.webdavClient && this.credentialId) {
          this.webdavClient = new WebDAVClient(this.credentialId);
        }

        const success = await this.syncToCloud();
        if (success) {
          this.updateSyncStatus('success');
          showToast('数据已成功同步到云端', 'success');
        } else {
          this.updateSyncStatus('error');
          showToast('同步到云端失败，请检查网络连接', 'error');
        }
      } catch (error) {
        console.error('同步失败:', error);
        this.updateSyncStatus('error');
        showToast('同步到云端失败，请稍后重试', 'error');
      } finally {
        this.syncInProgress = false;
      }
    }, 3000); // 3秒防抖延迟
  }

  // 处理 localStorage 变化
  handleStorageChange(event) {
    // 如果正在从云端同步到本地，则不处理本地数据变化
    if (this.isSyncingFromCloud || !this.syncEnabled) return;

    // 只处理特定的键值变化
    const syncKeys = [
      'viewingHistory',
      'selectedAPIs',
      'customAPIs',
      'yellowFilterEnabled',
      'adFilteringEnabled',
      'doubanEnabled',
      'autoplayEnabled',
      'userMovieTags',
      'userTvTags'
    ];

    if (syncKeys.includes(event.key)) {
      // 确保 WebDAV 客户端已初始化
      if (!this.webdavClient && this.credentialId) {
        this.webdavClient = new WebDAVClient(this.credentialId);
      }

      // 使用防抖处理同步
      this.debouncedSync();
    }
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
    `;
    document.head.appendChild(style);
  }

  // 同步管理器
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

  // 开启同步
  async enableSync() {
    if (!this.credentialId) {
      console.error('开启同步失败: 凭据ID为空');
      return false;
    }
    
    try {
      // 确保 WebDAV 客户端已初始化
      if (!this.webdavClient) {
        this.webdavClient = new WebDAVClient(this.credentialId);
      }
      
      const connected = await this.webdavClient.testConnection();
      if (!connected) {
        console.error('开启同步失败: WebDAV 连接测试失败');
        return false;
      }
      
      this.syncEnabled = true;
      localStorage.setItem('cloudSyncEnabled', 'true');
      localStorage.setItem('credentialId', this.credentialId);
      
      console.log('云同步已开启，准备进行首次同步');
      
      // 立即进行一次同步
      const syncResult = await this.syncToCloud();
      if (!syncResult) {
        console.error('首次同步失败');
      }
      
      // 启动定时同步
      this.startAutoSync();
      
      return true;
    } catch (error) {
      console.error('开启同步过程发生错误:', error);
      return false;
    }
  }

  // 关闭同步
  disableSync() {
    this.syncEnabled = false;
    localStorage.setItem('cloudSyncEnabled', 'false');
    this.stopAutoSync();
  }

  // 同步到云端
  async syncToCloud() {
    if (!this.syncEnabled || !this.webdavClient) {
      console.error('同步失败: 同步未启用或 WebDAV 客户端未初始化');
      return false;
    }

    try {
      // 先测试连接
      const connected = await this.webdavClient.testConnection();
      if (!connected) {
        console.error('同步失败: WebDAV 连接测试失败');
        return false;
      }

      // 获取所有需要同步的数据
      const localData = {
        settings: this.getSettingsToSync(),
        viewingHistory: this.getViewingHistoryToSync(),
        timestamp: Date.now(),
        credentialId: this.credentialId
      };

      console.log('准备同步的完整数据:', localData);

      // 上传本地数据
      const success = await this.webdavClient.uploadData(localData);
      if (success) {
        this.lastSyncTime = Date.now();
        localStorage.setItem('lastSyncTime', this.lastSyncTime);
        console.log('同步成功，时间戳:', this.lastSyncTime);
        return true;
      }

      console.error('同步失败: 上传数据失败');
      return false;
    } catch (error) {
      console.error('同步过程发生错误:', error);
      return false;
    }
  }

  // 从云端同步
  async syncFromCloud() {
    if (!this.syncEnabled || !this.webdavClient) {
      console.error('从云端同步失败: 同步未启用或 WebDAV 客户端未初始化');
      return false;
    }

    try {
      // 先测试连接
      const connected = await this.webdavClient.testConnection();
      if (!connected) {
        console.error('从云端同步失败: WebDAV 连接测试失败');
        return false;
      }

      const data = await this.webdavClient.downloadData();
      if (!data) {
        console.log('云端暂无数据');
        return false;
      }

      // 验证数据格式
      if (!this.validateCloudData(data)) {
        console.error('从云端同步失败: 数据格式无效');
        return false;
      }

      if (data.credentialId !== this.credentialId) {
        console.error('从云端同步失败: 凭据ID不匹配');
        return false;
      }

      // 显示同步中的提示
      showToast('正在从云端同步数据...', 'info');

      // 设置同步标志
      this.isSyncingFromCloud = true;

      try {
        // 直接应用云端数据
        if (data.settings) {
          console.log('正在应用云端设置...');
          this.applySettings(data.settings);
        }

        if (data.viewingHistory) {
          console.log('正在应用云端观看记录...');
          this.applyViewingHistory(data.viewingHistory);
        }
        
        this.lastSyncTime = Date.now();
        localStorage.setItem('lastSyncTime', this.lastSyncTime);
        
        console.log('从云端同步成功，时间戳:', this.lastSyncTime);
        showToast('数据已从云端同步成功', 'success');
        return true;
      } finally {
        // 清除同步标志
        this.isSyncingFromCloud = false;
      }
    } catch (error) {
      console.error('从云端同步过程发生错误:', error);
      showToast('从云端同步失败，请稍后重试', 'error');
      return false;
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

    if (data.settings && typeof data.settings !== 'object') {
      console.error('云端数据无效: 设置数据格式错误');
      return false;
    }

    if (data.viewingHistory) {
      if (typeof data.viewingHistory !== 'object') {
        console.error('云端数据无效: 观看历史数据格式错误');
        return false;
      }

      if (data.viewingHistory.history && !Array.isArray(data.viewingHistory.history)) {
        console.error('云端数据无效: 观看历史记录格式错误');
        return false;
      }

      if (data.viewingHistory.progress && typeof data.viewingHistory.progress !== 'object') {
        console.error('云端数据无效: 观看进度数据格式错误');
        return false;
      }
    }

    return true;
  }

  // 获取需要同步的设置
  getSettingsToSync() {
    const settings = {};
    
    // 获取选中的 API
    const selectedAPIs = localStorage.getItem('selectedAPIs');
    if (selectedAPIs) {
      try {
        settings.selectedAPIs = JSON.parse(selectedAPIs);
      } catch (e) {
        settings.selectedAPIs = [];
      }
    }

    // 获取自定义 API
    const customAPIs = localStorage.getItem('customAPIs');
    if (customAPIs) {
      try {
        settings.customAPIs = JSON.parse(customAPIs);
        console.log('准备同步的自定义API:', settings.customAPIs);
      } catch (e) {
        settings.customAPIs = [];
      }
    }

    // 获取其他设置
    settings.yellowFilterEnabled = localStorage.getItem('yellowFilterEnabled') === 'true';
    settings.adFilteringEnabled = localStorage.getItem(PLAYER_CONFIG.adFilteringStorage) === 'true';
    settings.doubanEnabled = localStorage.getItem('doubanEnabled') === 'true';
    settings.autoplayEnabled = localStorage.getItem('autoplayEnabled') === 'true';

    // 获取用户标签
    const userMovieTags = localStorage.getItem('userMovieTags');
    if (userMovieTags) {
      try {
        settings.userMovieTags = JSON.parse(userMovieTags);
      } catch (e) {
        settings.userMovieTags = [];
      }
    }

    const userTvTags = localStorage.getItem('userTvTags');
    if (userTvTags) {
      try {
        settings.userTvTags = JSON.parse(userTvTags);
      } catch (e) {
        settings.userTvTags = [];
      }
    }

    console.log('准备同步的完整设置:', settings);
    return settings;
  }

  // 获取需要同步的观看记录
  getViewingHistoryToSync() {
    const history = {
      history: [],
      progress: {}
    };

    // 获取观看历史
    const viewingHistory = localStorage.getItem('viewingHistory');
    if (viewingHistory) {
      try {
        history.history = JSON.parse(viewingHistory);
      } catch (e) {
        history.history = [];
      }
    }

    // 获取所有视频进度
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith('videoProgress_')) {
        try {
          const progress = JSON.parse(localStorage.getItem(key));
          history.progress[key] = progress;
        } catch (e) {
          console.error('解析视频进度失败:', key, e);
        }
      }
    });

    return history;
  }

  // 应用设置
  applySettings(settings) {
    if (!settings) return;

    try {
      // 保存选中的 API
      if (Array.isArray(settings.selectedAPIs)) {
        localStorage.setItem('selectedAPIs', JSON.stringify(settings.selectedAPIs));
        console.log('已同步选中的 API:', settings.selectedAPIs);
      }

      // 保存自定义 API
      if (Array.isArray(settings.customAPIs)) {
        localStorage.setItem('customAPIs', JSON.stringify(settings.customAPIs));
        console.log('已同步自定义 API:', settings.customAPIs);
      }

      // 保存其他设置
      if (typeof settings.yellowFilterEnabled === 'boolean') {
        localStorage.setItem('yellowFilterEnabled', settings.yellowFilterEnabled.toString());
        console.log('已同步黄色内容过滤设置:', settings.yellowFilterEnabled);
      }
      if (typeof settings.adFilteringEnabled === 'boolean') {
        localStorage.setItem(PLAYER_CONFIG.adFilteringStorage, settings.adFilteringEnabled.toString());
        console.log('已同步广告过滤设置:', settings.adFilteringEnabled);
      }
      if (typeof settings.doubanEnabled === 'boolean') {
        localStorage.setItem('doubanEnabled', settings.doubanEnabled.toString());
        console.log('已同步豆瓣设置:', settings.doubanEnabled);
      }
      if (typeof settings.autoplayEnabled === 'boolean') {
        localStorage.setItem('autoplayEnabled', settings.autoplayEnabled.toString());
        console.log('已同步自动播放设置:', settings.autoplayEnabled);
      }

      // 保存用户标签
      if (Array.isArray(settings.userMovieTags)) {
        localStorage.setItem('userMovieTags', JSON.stringify(settings.userMovieTags));
        console.log('已同步电影标签:', settings.userMovieTags);
      }
      if (Array.isArray(settings.userTvTags)) {
        localStorage.setItem('userTvTags', JSON.stringify(settings.userTvTags));
        console.log('已同步电视剧标签:', settings.userTvTags);
      }

      // 更新UI状态
      // 更新黄色内容过滤开关
      const yellowFilterToggle = document.getElementById('yellowFilterToggle');
      if (yellowFilterToggle) {
        yellowFilterToggle.checked = settings.yellowFilterEnabled;
      }

      // 更新广告过滤开关
      const adFilterToggle = document.getElementById('adFilterToggle');
      if (adFilterToggle) {
        adFilterToggle.checked = settings.adFilteringEnabled;
      }

      // 更新API复选框
      initAPICheckboxes();
      
      // 更新自定义API列表
      renderCustomAPIsList();
      
      // 更新选中的API数量
      updateSelectedApiCount();

      // 触发设置更新事件
      document.dispatchEvent(new CustomEvent('settingsUpdated'));
    } catch (error) {
      console.error('应用设置时发生错误:', error);
      throw error;
    }
  }

  // 应用观看记录
  applyViewingHistory(history) {
    if (!history) return;

    try {
      // 保存观看历史
      if (Array.isArray(history.history)) {
        localStorage.setItem('viewingHistory', JSON.stringify(history.history));
        console.log('已同步观看历史记录:', history.history.length, '条');
      }

      // 保存视频进度
      if (history.progress && typeof history.progress === 'object') {
        let progressCount = 0;
        Object.entries(history.progress).forEach(([key, value]) => {
          if (typeof value === 'object') {
            localStorage.setItem(key, JSON.stringify(value));
            progressCount++;
          }
        });
        console.log('已同步视频进度:', progressCount, '个');
      }
    } catch (error) {
      console.error('应用观看记录时发生错误:', error);
      throw error;
    }
  }

  // 启动自动同步
  startAutoSync() {
    this.stopAutoSync(); // 先停止现有的定时器
    this.autoSyncTimer = setInterval(async () => {
      if (this.syncEnabled) {
        await this.syncToCloud();
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
      // 1. 初始化WebDAV客户端
      const initSuccess = await this.init(credentialId);
      if (!initSuccess) {
        showToast('WebDAV 连接失败，请检查凭据ID', 'error');
        return;
      }

      // 2. 检查云端数据
      const cloudData = await this.webdavClient.downloadData();
      
      // 3. 启用同步
      this.syncEnabled = true;
      localStorage.setItem('cloudSyncEnabled', 'true');
      localStorage.setItem('credentialId', this.credentialId);

      if (cloudData) {
        // 验证云端数据
        if (!this.validateCloudData(cloudData)) {
          showToast('云端数据格式无效', 'error');
          return;
        }

        if (cloudData.credentialId !== credentialId) {
          showToast('云端数据与当前凭据ID不匹配', 'error');
          return;
        }

        // 4. 从云端同步数据到本地
        try {
          // 设置同步标志
          this.isSyncingFromCloud = true;

          try {
            // 直接应用云端数据
            if (cloudData.settings) {
              console.log('正在应用云端设置...');
              this.applySettings(cloudData.settings);
            }

            if (cloudData.viewingHistory) {
              console.log('正在应用云端观看记录...');
              this.applyViewingHistory(cloudData.viewingHistory);
            }
            
            this.lastSyncTime = Date.now();
            localStorage.setItem('lastSyncTime', this.lastSyncTime);
            
            console.log('从云端同步成功，时间戳:', this.lastSyncTime);
            showToast('云同步已开启，数据已从云端同步', 'success');

            // 刷新整个页面
            setTimeout(() => {
              window.location.reload();
            }, 2000); // 延迟2秒后刷新，让用户看到成功提示
          } finally {
            // 清除同步标志
            this.isSyncingFromCloud = false;
          }
        } catch (error) {
          console.error('从云端同步数据失败:', error);
          showToast('云同步已开启，但从云端同步数据失败', 'warning');
        }
      } else {
        // 云端没有数据，同步本地数据到云端
        const localData = {
          settings: this.getSettingsToSync(),
          viewingHistory: this.getViewingHistoryToSync(),
          timestamp: Date.now(),
          credentialId: this.credentialId
        };

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
    } catch (error) {
      console.error('开启云同步失败:', error);
      throw error;
    }
  }

  // 关闭云同步
  async disableCloudSync() {
    try {
      this.disableSync();
      showToast('云同步已关闭', 'info');
    } catch (error) {
      console.error('关闭云同步失败:', error);
      throw error;
    }
  }
}

// 创建全局同步管理器实例
window.syncManager = new SyncManager(); 