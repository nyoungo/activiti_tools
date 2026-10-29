'use strict'

/* =========================================================
 * Activiti 工作流运维工具 - 前端
 * 所有数据通过 /api 获取；操作统一使用 data-action 委托
 * ========================================================= */

const $ = (id) => document.getElementById(id)
const enc = encodeURIComponent

const VIEW_META = {
    overview: { title: '概览', subtitle: '当前数据库的工作流运行状况与异常概览' },
    instances: { title: '流程实例', subtitle: '查询、挂起、终止、变更版本，或跳转到指定节点' },
    tasks: { title: '待办任务', subtitle: '维护处理人、候选人与任务挂起状态' },
    definitions: { title: '流程定义', subtitle: '查看各版本流程图，调整挂起状态与 BPMN 内容' },
    jobs: { title: '定时作业', subtitle: '处理失败重试为 0 的异步作业与定时器' },
    audit: { title: '操作日志', subtitle: '本工具执行过的所有高危操作记录' }
}

const TYPE_LABEL = { mysql: 'MySQL', postgres: 'PostgreSQL', hgdatabase: '瀚高数据库' }

const NODE_TYPE_LABEL = {
    userTask: '用户任务',
    serviceTask: '服务任务',
    scriptTask: '脚本任务',
    manualTask: '手工任务',
    businessRuleTask: '规则任务',
    sendTask: '发送任务',
    receiveTask: '接收任务',
    callActivity: '调用子流程',
    subProcess: '子流程',
    startEvent: '开始事件',
    endEvent: '结束事件',
    exclusiveGateway: '排他网关',
    parallelGateway: '并行网关',
    inclusiveGateway: '包容网关',
    eventBasedGateway: '事件网关',
    complexGateway: '复杂网关',
    intermediateCatchEvent: '中间捕获事件',
    intermediateThrowEvent: '中间抛出事件',
    boundaryEvent: '边界事件'
}

const state = {
    connected: false,
    connection: null,
    userTable: true,
    users: [],
    userIndex: new Map(),
    definitions: [],
    configs: [],
    configId: null,
    view: 'overview',
    instanceStatus: 'running',
    instanceKeyword: '',
    instanceDefKey: '',
    instancePage: 1,
    instanceSize: 10,
    taskKeyword: '',
    taskAssignee: '',
    taskDefKey: '',
    taskPage: 1,
    taskSize: 10,
    definitionKeyword: '',
    jobKeyword: '',
    jobState: '',
    detailId: null,
    detail: null,
    detailTab: 'overview',
    detailDiagramMode: 'graph',
    detailData: { variables: [], history: [], activities: [], xml: null },
    modalTask: null
}

/* ============================ 工具函数 ============================ */

function esc(value) {
    if (value === null || value === undefined) return ''
    return String(value).replace(/[&<>"']/g, (char) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
    }[char]))
}

function fmtTime(value) {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleString('zh-CN', { hour12: false })
}

function toLocalInput(value) {
    if (!value) return ''
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return ''
    const pad = (num) => String(num).padStart(2, '0')
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

function fmtDuration(start, end) {
    if (!start) return '—'
    const startTime = new Date(start).getTime()
    const endTime = end ? new Date(end).getTime() : Date.now()
    if (Number.isNaN(startTime) || Number.isNaN(endTime)) return '—'
    const seconds = Math.max(0, Math.floor((endTime - startTime) / 1000))
    if (seconds < 60) return `${seconds} 秒`
    const minutes = Math.floor(seconds / 60)
    if (minutes < 60) return `${minutes} 分钟`
    const hours = Math.floor(minutes / 60)
    if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`
    const days = Math.floor(hours / 24)
    return `${days} 天 ${hours % 24} 小时`
}

function fmtNumber(value) {
    if (value === null || value === undefined) return '—'
    return Number(value).toLocaleString('zh-CN')
}

function userLabel(value) {
    if (value === null || value === undefined || value === '') return null
    const key = String(value)
    const user = state.userIndex.get(key)
    if (!user) return key
    return user.realname || user.username || key
}

function userHint(value) {
    if (!value) return ''
    const key = String(value)
    const user = state.userIndex.get(key)
    if (!user) return '未在 sys_user 中找到该用户'
    return `${user.realname || user.username}${user.username ? ` (${user.username})` : ''}`
}

function instanceBadge(instance) {
    if (instance.isFinished) return '<span class="badge badge-muted">已结束</span>'
    if (Number(instance.suspensionState) === 2) return '<span class="badge badge-warn">已挂起</span>'
    return '<span class="badge badge-success">运行中</span>'
}

function definitionBadge(definition) {
    return definition.suspended
        ? '<span class="badge badge-warn">已挂起</span>'
        : '<span class="badge badge-success">正常</span>'
}

function loadingState(text = '加载中…') {
    return `<div class="state-block"><span class="spinner"></span><p>${esc(text)}</p></div>`
}

function emptyState(title, hint = '') {
    return `<div class="state-block"><div class="state-icon">∅</div><p>${esc(title)}</p>${hint ? `<span>${esc(hint)}</span>` : ''}</div>`
}

function nodeTypeLabel(type) {
    return NODE_TYPE_LABEL[type] || type || '节点'
}

function renderUserOptions() {
    state.userIndex = new Map()
    state.users.forEach((user) => {
        if (user.id) state.userIndex.set(String(user.id), user)
        if (user.username) state.userIndex.set(String(user.username), user)
    })
    $('userOptions').innerHTML = state.users
        .map((user) => {
            const label = user.realname || user.username || user.id
            const extra = user.username && user.username !== label ? ` (${user.username})` : ''
            return `<option value="${esc(user.id)}" label="${esc(label + extra)}"></option>`
        })
        .join('')
}

/* ============================ API ============================ */

const api = {
    async request(url, options = {}) {
        let response
        try {
            response = await fetch(url, {
                headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
                ...options
            })
        } catch (error) {
            throw new Error('无法连接本地服务，请确认程序仍在运行')
        }

        const text = await response.text()
        let data = null
        if (text) {
            try {
                data = JSON.parse(text)
            } catch (error) {
                data = null
            }
        }

        if (!response.ok) {
            const error = new Error((data && data.error) || `请求失败（HTTP ${response.status}）`)
            error.status = response.status
            error.data = data
            throw error
        }
        return data
    },
    get(url) { return this.request(url) },
    post(url, body) { return this.request(url, { method: 'POST', body: JSON.stringify(body || {}) }) },
    put(url, body) { return this.request(url, { method: 'PUT', body: JSON.stringify(body || {}) }) },
    delete(url) { return this.request(url, { method: 'DELETE' }) }
}

/* ============================ 提示 / 弹层 ============================ */

function toast(message, type = 'info') {
    const root = $('toastRoot')
    const item = document.createElement('div')
    item.className = `toast toast-${type}`
    item.innerHTML = `<span class="toast-dot"></span><span>${esc(message)}</span>`
    item.addEventListener('click', () => item.remove())
    root.appendChild(item)
    setTimeout(() => {
        item.classList.add('toast-out')
        setTimeout(() => item.remove(), 250)
    }, type === 'error' ? 6000 : 3600)
}

function handleError(error) {
    console.error(error)
    toast(error && error.message ? error.message : '操作失败', 'error')
    if (error && error.status === 409) {
        state.connected = false
        showConnectionScreen()
    }
}

async function withBusy(element, work) {
    if (!element) return work()
    element.classList.add('is-busy')
    element.disabled = true
    try {
        return await work()
    } finally {
        element.classList.remove('is-busy')
        element.disabled = false
    }
}

let dialogResolver = null

function modalShell(title, body, footer, closeAction = 'modal-close') {
    return `
        <header class="modal-head">
            <h3>${esc(title)}</h3>
            <button type="button" class="icon-btn" data-action="${closeAction}" aria-label="关闭">×</button>
        </header>
        <div class="modal-body">${body}</div>
        ${footer ? `<footer class="modal-foot">${footer}</footer>` : ''}
    `
}

function openModal(html, size = 'md') {
    const root = $('modalRoot')
    // 先销毁上一次的流程图实例，避免事件监听残留
    destroyBpmnHost(root.querySelector('[data-bpmn-editor]'))
    root.hidden = false
    root.innerHTML = `<div class="modal-backdrop" data-action="modal-close"></div><div class="modal modal-${size}" role="dialog" aria-modal="true">${html}</div>`
    syncBodyLock()
}

function closeModal(result = null) {
    const root = $('modalRoot')
    destroyBpmnHost(root.querySelector('[data-bpmn-editor]'))
    root.hidden = true
    root.innerHTML = ''
    syncBodyLock()
    return result
}

/* 确认框使用独立图层，避免覆盖正在编辑的弹层（如流程图编辑器） */

function openDialog(html) {
    const root = $('dialogRoot')
    root.hidden = false
    root.innerHTML = `<div class="modal-backdrop" data-action="dialog-cancel"></div><div class="modal modal-sm" role="dialog" aria-modal="true">${html}</div>`
    syncBodyLock()
}

function closeDialog(result = null) {
    const root = $('dialogRoot')
    root.hidden = true
    root.innerHTML = ''
    syncBodyLock()
    const resolve = dialogResolver
    dialogResolver = null
    if (resolve) resolve(result)
}

// 多个弹层可能同时打开，统一按「是否还有可见弹层」决定是否锁定页面滚动
function syncBodyLock() {
    const anyOpen = ['modalRoot', 'dialogRoot', 'drawerRoot'].some((id) => {
        const el = $(id)
        return el && !el.hidden
    })
    document.body.classList.toggle('modal-open', anyOpen)
}

function askDialog(options = {}) {
    const {
        title = '确认操作',
        message = '',
        label = '',
        placeholder = '',
        value = '',
        confirmText = '确定',
        cancelText = '取消',
        danger = false,
        multiline = false
    } = options

    return new Promise((resolve) => {
        dialogResolver = resolve
        const inputHtml = label
            ? `<label class="field"><span>${esc(label)}</span>${multiline
                ? `<textarea id="dialogInput" rows="3" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`
                : `<input id="dialogInput" type="text" placeholder="${esc(placeholder)}" value="${esc(value)}">`
            }</label>`
            : ''
        openDialog(modalShell(title, `<div class="dialog-message">${message}</div>${inputHtml}`, `
            <button type="button" class="btn btn-secondary" data-action="dialog-cancel">${esc(cancelText)}</button>
            <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-action="dialog-confirm">${esc(confirmText)}</button>
        `, 'dialog-cancel'))

        const input = $('dialogInput')
        if (input) {
            setTimeout(() => {
                input.focus()
                if (input.select) input.select()
            }, 30)
        }
    })
}

/* ============================ 连接页 ============================ */

function setConnMessage(text, type = '') {
    const el = $('connMessage')
    el.textContent = text || ''
    el.className = `form-message ${type}`.trim()
}

function readConnectionForm() {
    return {
        id: state.configId || undefined,
        name: $('connName').value.trim(),
        dbType: $('connType').value,
        host: $('connHost').value.trim() || 'localhost',
        port: Number($('connPort').value) || defaultPort($('connType').value),
        database: $('connDatabase').value,
        schema: $('connSchema').value,
        username: $('connUser').value.trim(),
        password: $('connPass').value
    }
}

function basicConfig() {
    const config = readConnectionForm()
    return {
        dbType: config.dbType,
        host: config.host,
        port: config.port,
        username: config.username,
        password: config.password,
        database: config.database
    }
}

function defaultPort(dbType) {
    if (dbType === 'mysql') return 3306
    if (dbType === 'hgdatabase') return 5866
    return 5432
}

function resetConnectionForm() {
    state.configId = null
    $('connName').value = ''
    $('connType').value = 'mysql'
    $('connHost').value = 'localhost'
    $('connPort').value = '3306'
    $('connUser').value = ''
    $('connPass').value = ''
    $('connDatabase').innerHTML = '<option value="">先测试连接获取数据库</option>'
    $('connDatabase').disabled = true
    $('connSchema').innerHTML = '<option value="">先选择数据库</option>'
    $('connSchema').disabled = true
    $('schemaField').hidden = true
    setConnMessage('')
    renderSavedConnections()
}

function renderSavedConnections() {
    const list = $('savedConnectionList')
    if (!state.configs.length) {
        list.innerHTML = '<div class="state-block state-block-sm"><p>还没有保存的配置</p><span>填写右侧表单后点击「保存配置」</span></div>'
        return
    }
    list.innerHTML = state.configs.map((config) => `
        <div class="saved-item ${state.configId === config.id ? 'is-active' : ''}">
            <button type="button" class="saved-item-main" data-action="conn-pick" data-id="${config.id}" title="载入此配置">
                <strong>${esc(config.name)}</strong>
                <span>${esc(TYPE_LABEL[config.db_type] || config.db_type)} · ${esc(config.host)}:${esc(config.port)}/${esc(config.database)}</span>
            </button>
            <button type="button" class="icon-btn icon-btn-sm" data-action="conn-delete" data-id="${config.id}" title="删除配置">×</button>
        </div>
    `).join('')
}

async function loadSavedConnections() {
    try {
        state.configs = await api.get('/api/connections')
        renderSavedConnections()
    } catch (error) {
        toast(error.message, 'error')
    }
}

async function pickConnection(id) {
    try {
        const config = await api.get(`/api/connections/${id}`)
        state.configId = config.id
        $('connName').value = config.name || ''
        $('connType').value = config.db_type || 'mysql'
        $('connHost').value = config.host || ''
        $('connPort').value = config.port || defaultPort(config.db_type)
        $('connUser').value = config.username || ''
        $('connPass').value = config.password || ''
        $('schemaField').hidden = config.db_type === 'mysql'
        renderSavedConnections()

        await loadDatabaseList(true)
        $('connDatabase').value = config.database || ''
        if (config.db_type !== 'mysql' && config.database) {
            await loadSchemaList(config.database, true)
            $('connSchema').value = config.schema || ''
        }
        setConnMessage('配置已载入，点击「连接数据库」进入工作台', 'success')
    } catch (error) {
        setConnMessage(error.message, 'error')
    }
}

async function loadDatabaseList(silent = false) {
    const button = document.querySelector('[data-action="conn-load-databases"]')
    try {
        const data = await withBusy(button, () => api.post('/api/test-basic-connection', basicConfig()))
        const select = $('connDatabase')
        select.innerHTML = '<option value="">请选择数据库</option>' + (data.databases || [])
            .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
            .join('')
        select.disabled = false
        if (!silent) {
            setConnMessage(`连接成功，发现 ${(data.databases || []).length} 个数据库`, 'success')
        }
        return data.databases || []
    } catch (error) {
        if (!silent) setConnMessage(error.message, 'error')
        throw error
    }
}

async function loadSchemaList(database, silent = false) {
    const config = basicConfig()
    config.database = database
    try {
        const data = await api.post('/api/get-schemas', config)
        const select = $('connSchema')
        select.innerHTML = '<option value="">请选择 Schema</option>' + (data.schemas || [])
            .map((name) => `<option value="${esc(name)}">${esc(name)}</option>`)
            .join('')
        select.disabled = false
        if (!silent) setConnMessage('请选择 Schema', 'success')
        return data.schemas || []
    } catch (error) {
        if (!silent) setConnMessage(error.message, 'error')
        throw error
    }
}

async function testConnection(button) {
    try {
        const data = await withBusy(button, () => api.post('/api/test-connection', readConnectionForm()))
        setConnMessage(`${data.message}（检测到 ${data.tables} 张表）`, 'success')
        toast('连接测试通过', 'success')
    } catch (error) {
        setConnMessage(error.message, 'error')
        toast('连接测试失败', 'error')
    }
}

async function saveConnection(button) {
    if (!$('connName').value.trim()) {
        setConnMessage('请填写连接名称', 'error')
        return
    }
    if (!$('connDatabase').value) {
        setConnMessage('请先选择数据库', 'error')
        return
    }
    try {
        const config = readConnectionForm()
        const data = await withBusy(button, () => api.post('/api/connections', config))
        state.configId = data.id
        state.configs = await api.get('/api/connections')
        renderSavedConnections()
        setConnMessage('配置已保存到本机', 'success')
        toast('配置已保存', 'success')
    } catch (error) {
        setConnMessage(error.message, 'error')
    }
}

async function deleteSavedConnection(id) {
    const target = state.configs.find((item) => item.id === id)
    const ok = await askDialog({
        title: '删除连接配置',
        message: `确定删除配置 <strong>${esc(target ? target.name : id)}</strong> 吗？只会删除本机保存的信息，不会影响数据库。`,
        confirmText: '删除',
        danger: true
    })
    if (ok === null) return
    await api.delete(`/api/connections/${id}`)
    if (state.configId === id) state.configId = null
    state.configs = await api.get('/api/connections')
    renderSavedConnections()
    toast('配置已删除', 'success')
}

async function connectDatabase(button) {
    const config = readConnectionForm()
    if (!config.database) {
        setConnMessage('请先选择数据库', 'error')
        return
    }
    if (!config.username) {
        setConnMessage('请填写用户名', 'error')
        return
    }
    try {
        const data = await withBusy(button, () => api.post('/api/connect', config))
        setConnMessage(data.message || '连接成功', 'success')
        await checkConnection()
        toast('已连接数据库', 'success')
    } catch (error) {
        setConnMessage(error.message, 'error')
        toast('连接失败', 'error')
    }
}

/* ============================ 工作台 ============================ */

async function checkConnection() {
    try {
        const status = await api.get('/api/connection-status')
        if (status.connected) {
            await enterWorkspace(status)
            return
        }
    } catch (error) {
        console.warn(error.message)
    }
    showConnectionScreen()
}

function showConnectionScreen() {
    state.connected = false
    state.detail = null
    $('workspace').hidden = true
    $('connectionScreen').hidden = false
    $('drawerRoot').hidden = true
    syncBodyLock()
    renderSavedConnections()
}

async function enterWorkspace(status) {
    state.connected = true
    state.connection = status.config || null
    state.userTable = status.userTable !== false

    $('connectionScreen').hidden = true
    $('workspace').hidden = false
    updateSidebarConnection()

    await loadUsers()
    await ensureDefinitions()
    setView(state.view || 'overview')
}

function updateSidebarConnection() {
    const config = state.connection || {}
    $('sidebarConnName').textContent = config.name || '已连接'
    const database = config.database ? `/${config.database}` : ''
    const schema = config.schema ? ` · ${config.schema}` : ''
    $('sidebarConnInfo').textContent = `${TYPE_LABEL[config.dbType] || config.dbType || ''} · ${config.host || ''}:${config.port || ''}${database}${schema}`
    $('userTableHint').hidden = state.userTable !== false
}

async function loadUsers() {
    try {
        const data = await api.get('/api/users')
        state.users = data.items || []
        renderUserOptions()
    } catch (error) {
        state.users = []
        renderUserOptions()
    }
}

function setView(view) {
    if (!VIEW_META[view]) view = 'overview'
    state.view = view
    document.querySelectorAll('.view').forEach((section) => {
        section.hidden = section.id !== `view-${view}`
    })
    document.querySelectorAll('.nav-item').forEach((item) => {
        item.classList.toggle('is-active', item.dataset.nav === view)
    })
    $('pageTitle').textContent = VIEW_META[view].title
    $('pageSubtitle').textContent = VIEW_META[view].subtitle
    loadView(view).catch(handleError)
}

async function loadView(view) {
    if (!state.connected) return
    if (view === 'overview') return loadOverview()
    if (view === 'instances') return loadInstances()
    if (view === 'tasks') return loadTasks()
    if (view === 'definitions') return loadDefinitionsView()
    if (view === 'jobs') return loadJobs()
    if (view === 'audit') return loadAudit()
}

/* ============================ 概览 ============================ */

async function loadOverview() {
    $('overviewStats').innerHTML = `<div class="stat-card is-loading"><span class="spinner"></span></div>`.repeat(6)

    const [overview, instances, jobs] = await Promise.all([
        api.get('/api/overview'),
        api.get('/api/instances?status=running&size=5').catch(() => ({ items: [] })),
        api.get('/api/jobs?state=failed&size=5').catch(() => ({ items: [] }))
    ])

    const cards = [
        { label: '运行中实例', value: overview.runningInstances, tone: 'blue', nav: 'instances' },
        { label: '待办任务', value: overview.pendingTasks, tone: 'indigo', nav: 'tasks' },
        { label: '未分配任务', value: overview.unassignedTasks, tone: 'amber', nav: 'tasks' },
        { label: '今日已结束', value: overview.finishedToday, tone: 'green', nav: 'instances' },
        { label: '失败作业', value: overview.failedJobs, tone: 'red', nav: 'jobs' },
        { label: '流程定义', value: overview.definitions, tone: 'slate', nav: 'definitions' }
    ]

    $('overviewStats').innerHTML = cards.map((card) => `
        <button type="button" class="stat-card tone-${card.tone}" data-nav="${card.nav}">
            <span class="stat-label">${card.label}</span>
            <strong class="stat-value">${card.value === null ? '—' : fmtNumber(card.value)}</strong>
            ${card.value === null ? '<span class="stat-hint">该表不可用</span>' : ''}
        </button>
    `).join('')

    $('overviewInstances').innerHTML = (instances.items || []).length
        ? `<ul class="compact-list">${instances.items.map((item) => `
            <li>
                <button type="button" class="compact-row" data-action="open-instance" data-id="${esc(item.id)}">
                    <span class="compact-main">
                        <strong>${esc(item.procDefName || item.procDefKey || '未命名流程')}</strong>
                        <span>${esc(item.businessKey || item.id)} · ${esc(item.startUserLabel || item.startUserId || '未知发起人')}</span>
                    </span>
                    <span class="compact-side">${esc(fmtTime(item.startTime))}</span>
                </button>
            </li>`).join('')}</ul>`
        : emptyState('暂无运行中的流程')

    $('overviewJobs').innerHTML = (jobs.items || []).length
        ? `<ul class="compact-list">${jobs.items.map((job) => `
            <li>
                <button type="button" class="compact-row" data-action="job-detail" data-id="${esc(job.id)}" data-source="${esc(job.source)}">
                    <span class="compact-main">
                        <strong>${esc(job.sourceLabel)} · 重试 ${job.retries === null ? '—' : job.retries}</strong>
                        <span>${esc(job.exceptionMessage || job.handlerType || '无异常信息')}</span>
                    </span>
                    <span class="compact-side">${esc(fmtTime(job.dueDate))}</span>
                </button>
            </li>`).join('')}</ul>`
        : emptyState('没有失败的作业', '所有异步作业与定时器状态正常')
}

/* ============================ 流程实例 ============================ */

async function loadInstances() {
    const container = $('instancesTable')
    container.innerHTML = loadingState('加载流程实例…')

    const params = new URLSearchParams({
        status: state.instanceStatus,
        page: String(state.instancePage),
        size: String(state.instanceSize),
        keyword: state.instanceKeyword,
        procDefKey: state.instanceDefKey
    })

    const data = await api.get(`/api/instances?${params.toString()}`)
    const items = data.items || []

    if (!items.length) {
        container.innerHTML = emptyState('没有匹配的流程实例', state.instanceKeyword ? '试试清空搜索条件' : '')
        $('instancesPager').innerHTML = ''
        return
    }

    container.innerHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th>流程 / 实例ID</th>
                    <th>业务键</th>
                    <th>发起人</th>
                    <th>开始时间</th>
                    <th>状态</th>
                    <th class="col-actions">操作</th>
                </tr>
            </thead>
            <tbody>
                ${items.map((item) => `
                    <tr>
                        <td>
                            <div class="cell-title">${esc(item.procDefName || item.procDefKey || '未命名流程')}</div>
                            <div class="cell-sub"><code>${esc(item.id)}</code></div>
                        </td>
                        <td>${item.businessKey ? `<span class="mono">${esc(item.businessKey)}</span>` : '<span class="muted">—</span>'}</td>
                        <td>${esc(item.startUserLabel || item.startUserId || '—')}</td>
                        <td class="nowrap">${esc(fmtTime(item.startTime))}</td>
                        <td>
                            ${instanceBadge(item)}
                            ${item.currentTaskNames ? `<div class="cell-sub">${esc(item.currentTaskNames)}</div>` : ''}
                        </td>
                        <td class="col-actions">
                            <button type="button" class="btn btn-ghost btn-xs" data-action="open-instance" data-id="${esc(item.id)}">详情</button>
                            ${item.isFinished
                                ? `<button type="button" class="btn btn-danger-ghost btn-xs" data-action="instance-purge" data-id="${esc(item.id)}">删除</button>`
                                : `<button type="button" class="btn btn-ghost btn-xs" data-action="instance-quick-toggle" data-id="${esc(item.id)}" data-suspended="${Number(item.suspensionState) === 2 ? '1' : '0'}">${Number(item.suspensionState) === 2 ? '激活' : '挂起'}</button>
                                   <button type="button" class="btn btn-danger-ghost btn-xs" data-action="instance-terminate" data-id="${esc(item.id)}">终止</button>`}
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `
    renderPager($('instancesPager'), data.total || 0, data.page || 1, data.size || state.instanceSize, 'instance-page')
}

function renderPager(container, total, page, size, action) {
    const totalPages = Math.max(1, Math.ceil(total / size))
    const pages = []
    for (let index = 1; index <= totalPages; index += 1) {
        if (index === 1 || index === totalPages || Math.abs(index - page) <= 2) pages.push(index)
        else if (pages[pages.length - 1] !== '…') pages.push('…')
    }

    container.innerHTML = `
        <span class="pager-info">共 ${fmtNumber(total)} 条 · 第 ${page}/${totalPages} 页</span>
        <div class="pager-buttons">
            <button type="button" class="btn btn-ghost btn-sm" data-action="${action}" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>上一页</button>
            ${pages.map((item) => item === '…'
                ? '<span class="pager-gap">…</span>'
                : `<button type="button" class="btn btn-sm ${item === page ? 'btn-primary' : 'btn-ghost'}" data-action="${action}" data-page="${item}">${item}</button>`).join('')}
            <button type="button" class="btn btn-ghost btn-sm" data-action="${action}" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>下一页</button>
        </div>
    `
}

/* ============================ 流程实例详情弹窗 ============================ */

async function openInstance(id) {
    state.detailId = id
    state.detail = null
    state.detailTab = 'overview'
    state.detailDiagramMode = 'graph'
    state.detailData = { variables: [], history: [], activities: [], xml: null }
    $('drawerRoot').hidden = false
    syncBodyLock()
    renderDrawer()
    try {
        await reloadDetail()
    } catch (error) {
        handleError(error)
        closeDrawer()
    }
}

async function reloadDetail() {
    if (!state.detailId) return
    const id = enc(state.detailId)
    const [detail, variables, history, activities] = await Promise.all([
        api.get(`/api/instances/${id}`),
        api.get(`/api/instances/${id}/variables`).catch(() => []),
        api.get(`/api/instances/${id}/history-tasks`).catch(() => []),
        api.get(`/api/instances/${id}/activities`).catch(() => [])
    ])
    state.detail = detail
    state.detailData.variables = variables || []
    state.detailData.history = history || []
    state.detailData.activities = activities || []
    renderDrawer()
}

function closeDrawer() {
    destroyBpmnHost(document.querySelector('#drawerRoot [data-bpmn-editor]'))
    state.detail = null
    state.detailId = null
    state.detailTab = 'overview'
    state.detailDiagramMode = 'graph'
    state.detailData = { variables: [], history: [], activities: [], xml: null }
    $('drawerRoot').hidden = true
    $('drawerRoot').innerHTML = ''
    syncBodyLock()
}

function renderDrawer() {
    const root = $('drawerRoot')
    if (root.hidden) return
    const detail = state.detail

    // 重新渲染会替换 DOM，先销毁旧的 bpmn 实例，避免事件与内存泄漏
    destroyBpmnHost(document.querySelector('#drawerRoot [data-bpmn-editor]'))

    if (!detail) {
        root.innerHTML = `<div class="drawer-backdrop" data-action="close-drawer"></div>
            <aside class="drawer" role="dialog" aria-modal="true" aria-label="实例详情">
                <div class="drawer-loading"><span class="spinner"></span>加载实例详情…</div>
            </aside>`
        syncBodyLock()
        return
    }

    const data = state.detailData
    const tabs = [
        { key: 'overview', label: '概览' },
        { key: 'tasks', label: `当前任务 ${detail.currentTasks.length}` },
        { key: 'variables', label: `变量 ${data.variables.length}` },
        { key: 'activities', label: '流转轨迹' },
        { key: 'history', label: `历史任务 ${data.history.length}` },
        { key: 'xml', label: '流程图' }
    ]

    const suspended = Number(detail.suspensionState) === 2

    root.innerHTML = `
        <div class="drawer-backdrop" data-action="close-drawer"></div>
        <aside class="drawer" role="dialog" aria-modal="true" aria-label="实例详情">
            <header class="drawer-head">
                <div class="drawer-head-main">
                    <div class="drawer-eyebrow">
                        ${instanceBadge(detail)}
                        <code>${esc(detail.id)}</code>
                    </div>
                    <h2>${esc(detail.procDefName || detail.procDefKey || '流程实例')}</h2>
                    <p class="drawer-sub">
                        ${detail.procDefKey ? esc(detail.procDefKey) : '—'}
                        ${detail.procDefVersion ? ` · v${esc(detail.procDefVersion)}` : ''}
                        · 发起人 ${esc(detail.startUserLabel || detail.startUserId || '—')}
                        ${detail.businessKey ? ` · 业务键 ${esc(detail.businessKey)}` : ''}
                    </p>
                </div>
                <button type="button" class="icon-btn" data-action="close-drawer" aria-label="关闭">×</button>
            </header>

            <div class="drawer-actions">
                <button type="button" class="btn btn-secondary btn-sm" data-action="instance-toggle" ${detail.isFinished ? 'disabled' : ''}>
                    ${suspended ? '激活实例' : '挂起实例'}
                </button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="instance-jump-node">跳转 / 重激活节点</button>
                <button type="button" class="btn btn-secondary btn-sm" data-action="instance-migrate" ${detail.isFinished ? 'disabled' : ''}>变更流程版本</button>
                <button type="button" class="btn btn-danger-ghost btn-sm" data-action="instance-terminate">终止流程</button>
                <button type="button" class="btn btn-danger-ghost btn-sm" data-action="instance-purge">彻底删除</button>
                <span class="spacer"></span>
                <button type="button" class="btn btn-ghost btn-sm" data-action="instance-refresh">刷新</button>
            </div>

            <nav class="drawer-tabs">
                ${tabs.map((tab) => `
                    <button type="button" class="drawer-tab ${state.detailTab === tab.key ? 'is-active' : ''}" data-action="drawer-tab" data-tab="${tab.key}">
                        ${tab.label}
                    </button>`).join('')}
            </nav>

            <div class="drawer-body${state.detailTab === 'xml' ? ' drawer-body-flush' : ''}">${renderDrawerTab()}</div>
        </aside>
    `
    syncBodyLock()

    // 流程图标签页渲染完成后挂载 bpmn 实例（容器必须已在文档中）
    if (state.detailTab === 'xml' && dataReadyForDiagram()) mountDrawerDiagram()
}

function dataReadyForDiagram() {
    return state.detailData.xml !== null && state.detailData.xml !== ''
}

function mountDrawerDiagram() {
    const root = document.querySelector('#drawerRoot [data-bpmn-editor]')
    if (!root) return
    mountBpmnEditor(root, {
        xml: state.detailData.xml,
        editable: true,
        onSaved: (xml) => {
            state.detailData.xml = xml
            state.xmlOriginal = xml
        }
    }).catch((error) => {
        const canvas = root.querySelector('[data-bpmn-canvas]')
        if (canvas) canvas.innerHTML = emptyState('流程图加载失败', esc(error.message || ''))
    })
}

function renderDrawerTab() {
    const detail = state.detail
    const data = state.detailData
    const finished = detail.isFinished

    if (state.detailTab === 'tasks') {
        if (!detail.currentTasks.length) {
            return emptyState(finished ? '流程已结束，没有当前任务' : '没有当前任务', '可以使用「跳转 / 重激活节点」重新创建任务')
        }
        return `
            <table class="table">
                <thead><tr><th>任务</th><th>处理人 / 候选人</th><th>创建时间</th><th class="col-actions">操作</th></tr></thead>
                <tbody>
                    ${detail.currentTasks.map((task) => `
                        <tr>
                            <td>
                                <div class="cell-title">${esc(task.name || task.taskDefKey || '任务')}</div>
                                <div class="cell-sub"><code>${esc(task.id)}</code>${Number(task.suspensionState) === 2 ? ' <span class="badge badge-warn">已挂起</span>' : ''}</div>
                            </td>
                            <td>
                                ${task.assignee ? esc(task.assigneeLabel || task.assignee) : '<span class="badge badge-muted">未分配</span>'}
                                ${task.candidates && task.candidates.length
                                    ? `<div class="cell-sub">候选：${task.candidates.map((candidate) => esc(candidate.label || candidate.userId || candidate.groupId)).join('、')}</div>`
                                    : ''}
                            </td>
                            <td class="nowrap">${esc(fmtTime(task.createTime))}</td>
                            <td class="col-actions">
                                <button type="button" class="btn btn-ghost btn-xs" data-action="open-task"
                                    data-id="${esc(task.id)}" data-name="${esc(task.name || '')}" data-assignee="${esc(task.assignee || '')}">处理人</button>
                                <button type="button" class="btn btn-ghost btn-xs" data-action="task-toggle"
                                    data-id="${esc(task.id)}" data-suspended="${Number(task.suspensionState) === 2 ? '1' : '0'}">
                                    ${Number(task.suspensionState) === 2 ? '激活' : '挂起'}
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>`
    }

    if (state.detailTab === 'variables') {
        return `
            <div class="section-head">
                <h4>流程变量</h4>
                <div class="section-actions">
                    ${finished ? '' : '<button type="button" class="btn btn-primary btn-sm" data-action="variable-add">新增变量</button>'}
                    ${finished ? '<span class="muted">已结束实例的变量仅可查看 / 删除</span>' : ''}
                </div>
            </div>
            ${data.variables.length ? `
                <table class="table">
                    <thead><tr><th>变量名</th><th>类型</th><th>值</th><th class="col-actions">操作</th></tr></thead>
                    <tbody>
                        ${data.variables.map((variable) => `
                            <tr>
                                <td><code>${esc(variable.name)}</code></td>
                                <td><span class="badge badge-slate">${esc(variable.type)}</span></td>
                                <td class="var-value">${esc(variable.display !== null && variable.display !== undefined ? variable.display : formatVariableValue(variable))}</td>
                                <td class="col-actions">
                                    ${variable.editable && !finished
                                        ? `<button type="button" class="btn btn-ghost btn-xs" data-action="variable-edit" data-name="${esc(variable.name)}">修改</button>`
                                        : ''}
                                    <button type="button" class="btn btn-danger-ghost btn-xs" data-action="variable-delete" data-name="${esc(variable.name)}">删除</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : emptyState('暂无流程变量')}
        `
    }

    if (state.detailTab === 'activities') {
        if (!data.activities.length) return emptyState('暂无流转记录', '当前数据库可能未开启完整历史级别')
        return `
            <ol class="timeline">
                ${data.activities.map((activity) => `
                    <li class="timeline-item">
                        <span class="timeline-dot ${activity.endTime ? '' : 'is-active'}"></span>
                        <div class="timeline-main">
                            <div class="timeline-title">
                                ${esc(activity.activityName || activity.activityId)}
                                <span class="badge badge-slate">${esc(nodeTypeLabel(activity.activityType))}</span>
                            </div>
                            <div class="timeline-meta">
                                ${esc(fmtTime(activity.startTime))} → ${activity.endTime ? esc(fmtTime(activity.endTime)) : '进行中'}
                                · ${esc(fmtDuration(activity.startTime, activity.endTime))}
                                ${activity.assigneeLabel ? ` · ${esc(activity.assigneeLabel)}` : ''}
                                ${activity.deleteReason ? ` · ${esc(activity.deleteReason)}` : ''}
                            </div>
                        </div>
                    </li>
                `).join('')}
            </ol>
        `
    }

    if (state.detailTab === 'history') {
        if (!data.history.length) return emptyState('暂无历史任务')
        return `
            <table class="table">
                <thead><tr><th>任务</th><th>处理人</th><th>开始</th><th>结束</th><th class="col-actions">操作</th></tr></thead>
                <tbody>
                    ${data.history.map((task) => `
                        <tr>
                            <td>
                                <div class="cell-title">${esc(task.name || '任务')}</div>
                                <div class="cell-sub"><code>${esc(task.id)}</code>${task.deleteReason ? ` · ${esc(task.deleteReason)}` : ''}</div>
                                ${task.comment ? `
                                    <div class="cell-comment" title="${esc(task.comment)}">
                                        <span class="cell-comment-label">审批意见</span>${esc(task.comment)}
                                    </div>
                                    ${task.commentCount > 1 ? `<div class="cell-sub">共 ${task.commentCount} 条，编辑时修改最新一条</div>` : ''}
                                ` : ''}
                            </td>
                            <td>${task.assignee ? esc(task.assigneeLabel || task.assignee) : '<span class="muted">—</span>'}</td>
                            <td class="nowrap">${esc(fmtTime(task.startTime))}</td>
                            <td class="nowrap">${task.endTime ? esc(fmtTime(task.endTime)) : '<span class="badge badge-success">进行中</span>'}</td>
                            <td class="col-actions">
                                <button type="button" class="btn btn-ghost btn-xs" data-action="history-edit" data-id="${esc(task.id)}">编辑</button>
                                <button type="button" class="btn btn-ghost btn-xs" data-action="history-jump"
                                    data-id="${esc(task.id)}" data-name="${esc(task.name || task.id)}">${task.endTime ? '退回此处' : '当前节点'}</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        `
    }

    if (state.detailTab === 'xml') {
        if (state.detailData.xml === null) return loadingState('加载流程图…')
        if (!state.detailData.xml) return emptyState('未找到 BPMN 文件', '该流程定义可能没有部署 XML 资源')
        return bpmnEditorMarkup({
            definitionId: detail.procDefId,
            editable: true,
            mode: state.detailDiagramMode,
            xml: state.detailData.xml,
            saveText: '保存'
        })
    }

    const rows = [
        ['实例ID', `<code>${esc(detail.id)}</code>`],
        ['流程定义', `${esc(detail.procDefName || '—')}${detail.procDefKey ? `（${esc(detail.procDefKey)} v${esc(detail.procDefVersion || '')}）` : ''}`],
        ['业务键', detail.businessKey ? esc(detail.businessKey) : '—'],
        ['发起人', esc(detail.startUserLabel || detail.startUserId || '—')],
        ['开始时间', esc(fmtTime(detail.startTime))],
        ['结束时间', detail.endTime ? esc(fmtTime(detail.endTime)) : '<span class="muted">未结束</span>'],
        ['运行时长', esc(fmtDuration(detail.startTime, detail.endTime))],
        ['状态', instanceBadge(detail)],
        ['当前节点', esc((detail.currentTasks || []).map((task) => task.name).filter(Boolean).join('、') || '—')],
        ['变量数量', `${detail.variableCount} 个`],
        ['历史任务', `${detail.historyTaskCount} 条`]
    ]
    if (detail.deleteReason) rows.push(['删除原因', esc(detail.deleteReason)])

    return `
        <div class="info-grid">
            ${rows.map(([label, value]) => `
                <div class="info-item">
                    <span>${esc(label)}</span>
                    <div>${value}</div>
                </div>`).join('')}
        </div>
        ${detail.isFinished ? '<div class="notice notice-info">该实例已结束。可使用「跳转 / 重激活节点」将流程重新激活到指定节点。</div>' : ''}
    `
}

function formatVariableValue(variable) {
    if (variable.value === null || variable.value === undefined) return ''
    if (typeof variable.value === 'object') return JSON.stringify(variable.value)
    return String(variable.value)
}

async function ensureDrawerXml() {
    if (!state.detail || state.detailData.xml !== null) return
    if (!state.detail.procDefId) {
        state.detailData.xml = ''
        return
    }
    const data = await api.get(`/api/definitions/${enc(state.detail.procDefId)}/xml`)
    state.detailData.xml = data.xml || ''
}

/* ============================ 待办任务 ============================ */

async function loadTasks() {
    const container = $('tasksTable')
    container.innerHTML = loadingState('加载待办任务…')

    const params = new URLSearchParams({
        page: String(state.taskPage),
        size: String(state.taskSize),
        keyword: state.taskKeyword,
        assignee: state.taskAssignee,
        procDefKey: state.taskDefKey
    })
    const data = await api.get(`/api/tasks?${params.toString()}`)
    const items = data.items || []

    if (!items.length) {
        container.innerHTML = emptyState('没有匹配的待办任务', state.taskKeyword ? '试试清空搜索条件' : '')
        $('tasksPager').innerHTML = ''
        return
    }

    container.innerHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th>任务 / 任务ID</th>
                    <th>所属流程</th>
                    <th>处理人</th>
                    <th>创建时间</th>
                    <th>到期时间</th>
                    <th class="col-actions">操作</th>
                </tr>
            </thead>
            <tbody>
                ${items.map((task) => `
                    <tr>
                        <td>
                            <div class="cell-title">${esc(task.name || task.taskDefKey || '任务')}</div>
                            <div class="cell-sub"><code>${esc(task.id)}</code>${Number(task.suspensionState) === 2 ? ' <span class="badge badge-warn">已挂起</span>' : ''}</div>
                        </td>
                        <td>
                            ${esc(task.procDefName || task.procDefKey || '—')}
                            <div class="cell-sub">${esc(task.businessKey || task.procInstId)}</div>
                        </td>
                        <td>
                            ${task.assignee ? esc(task.assigneeLabel || task.assignee) : '<span class="badge badge-muted">未分配</span>'}
                            ${task.candidates && task.candidates.length
                                ? `<div class="cell-sub">候选：${task.candidates.slice(0, 3).map((candidate) => esc(candidate.label || candidate.userId || candidate.groupId)).join('、')}${task.candidates.length > 3 ? '…' : ''}</div>`
                                : ''}
                        </td>
                        <td class="nowrap">${esc(fmtTime(task.createTime))}</td>
                        <td class="nowrap">${task.dueDate ? esc(fmtTime(task.dueDate)) : '<span class="muted">—</span>'}</td>
                        <td class="col-actions">
                            <button type="button" class="btn btn-ghost btn-xs" data-action="open-task"
                                data-id="${esc(task.id)}" data-name="${esc(task.name || '')}" data-assignee="${esc(task.assignee || '')}">处理人</button>
                            <button type="button" class="btn btn-ghost btn-xs" data-action="open-instance" data-id="${esc(task.procInstId)}">实例</button>
                            <button type="button" class="btn btn-ghost btn-xs" data-action="task-toggle"
                                data-id="${esc(task.id)}" data-suspended="${Number(task.suspensionState) === 2 ? '1' : '0'}">
                                ${Number(task.suspensionState) === 2 ? '激活' : '挂起'}
                            </button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `
    renderPager($('tasksPager'), data.total || 0, data.page || 1, data.size || state.taskSize, 'task-page')
}

/* ============================ 流程定义 ============================ */

async function ensureDefinitions() {
    try {
        state.definitions = await api.get('/api/definitions')
    } catch (error) {
        state.definitions = []
    }
    buildDefinitionFilters()
    return state.definitions
}

function buildDefinitionFilters() {
    const keys = new Map()
    state.definitions.forEach((definition) => {
        if (!keys.has(definition.key)) {
            keys.set(definition.key, definition.name || definition.key)
        }
    })
    const options = Array.from(keys.entries())
        .map(([key, name]) => `<option value="${esc(key)}">${esc(name)}</option>`)
        .join('')

    const instanceFilter = $('instanceDefFilter')
    instanceFilter.innerHTML = `<option value="">全部流程</option>${options}`
    instanceFilter.value = state.instanceDefKey

    const taskFilter = $('taskDefFilter')
    taskFilter.innerHTML = `<option value="">全部流程</option>${options}`
    taskFilter.value = state.taskDefKey
}

async function loadDefinitionsView() {
    const container = $('definitionsTable')
    container.innerHTML = loadingState('加载流程定义…')
    state.definitions = await api.get(`/api/definitions?keyword=${enc(state.definitionKeyword)}`)
    buildDefinitionFilters()

    $('definitionCount').textContent = `共 ${state.definitions.length} 个流程定义`

    if (!state.definitions.length) {
        container.innerHTML = emptyState('没有匹配的流程定义', '检查关键字，或确认数据库中存在 act_re_procdef 数据')
        return
    }

    container.innerHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th>流程名称</th>
                    <th>Key</th>
                    <th>版本</th>
                    <th>部署时间</th>
                    <th>运行中实例</th>
                    <th>状态</th>
                    <th class="col-actions">操作</th>
                </tr>
            </thead>
            <tbody>
                ${state.definitions.map((definition) => `
                    <tr>
                        <td>
                            <div class="cell-title">${esc(definition.name || definition.key)}</div>
                            <div class="cell-sub">${esc(definition.category || '未分类')}</div>
                        </td>
                        <td><code>${esc(definition.key)}</code></td>
                        <td><span class="badge badge-slate">v${esc(definition.version)}</span></td>
                        <td class="nowrap">${esc(fmtTime(definition.deployTime))}</td>
                        <td>${fmtNumber(definition.runningCount)}</td>
                        <td>${definitionBadge(definition)}</td>
                        <td class="col-actions">
                            <button type="button" class="btn btn-ghost btn-xs" data-action="xml-view" data-id="${esc(definition.id)}">流程图</button>
                            <button type="button" class="btn btn-ghost btn-xs" data-action="xml-edit" data-id="${esc(definition.id)}">编辑流程</button>
                            <button type="button" class="btn btn-ghost btn-xs" data-action="def-nodes" data-id="${esc(definition.id)}">节点</button>
                            <button type="button" class="btn btn-ghost btn-xs" data-action="def-toggle"
                                data-id="${esc(definition.id)}" data-suspended="${definition.suspended ? '1' : '0'}">
                                ${definition.suspended ? '激活' : '挂起'}
                            </button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `
}

/* ============================ 定时作业 ============================ */

async function loadJobs() {
    const container = $('jobsTable')
    container.innerHTML = loadingState('加载定时作业…')

    const params = new URLSearchParams({
        size: '100',
        keyword: state.jobKeyword,
        state: state.jobState
    })
    const data = await api.get(`/api/jobs?${params.toString()}`)
    const items = data.items || []

    if (!items.length) {
        container.innerHTML = emptyState('没有匹配的作业', state.jobKeyword ? '试试清空搜索条件' : '当前没有待执行的异步作业或定时器')
        return
    }

    container.innerHTML = `
        <table class="table">
            <thead>
                <tr>
                    <th>类型</th>
                    <th>作业ID</th>
                    <th>流程实例</th>
                    <th>重试</th>
                    <th>到期时间</th>
                    <th>异常信息</th>
                    <th class="col-actions">操作</th>
                </tr>
            </thead>
            <tbody>
                ${items.map((job) => `
                    <tr>
                        <td><span class="badge ${job.failed ? 'badge-danger' : job.source === 'timer' ? 'badge-blue' : 'badge-slate'}">${esc(job.sourceLabel)}</span></td>
                        <td>
                            <div class="cell-sub"><code>${esc(job.id)}</code></div>
                            <div class="cell-sub">${esc(job.handlerType || job.type || '')}</div>
                        </td>
                        <td>
                            ${job.processInstanceId
                                ? `<button type="button" class="link-btn mono" data-action="open-instance" data-id="${esc(job.processInstanceId)}">${esc(job.processInstanceId)}</button>`
                                : '<span class="muted">—</span>'}
                        </td>
                        <td>${job.retries === null ? '—' : `<span class="badge ${job.failed ? 'badge-danger' : 'badge-muted'}">${job.retries}</span>`}</td>
                        <td class="nowrap">${esc(fmtTime(job.dueDate))}</td>
                        <td class="job-message">${job.exceptionMessage ? `<span title="${esc(job.exceptionMessage)}">${esc(job.exceptionMessage.slice(0, 90))}${job.exceptionMessage.length > 90 ? '…' : ''}</span>` : '<span class="muted">—</span>'}</td>
                        <td class="col-actions">
                            <button type="button" class="btn btn-ghost btn-xs" data-action="job-execute" data-id="${esc(job.id)}" data-source="${esc(job.source)}" ${['async', 'timer'].includes(job.source) ? '' : 'disabled'}>立即执行</button>
                            <button type="button" class="btn btn-ghost btn-xs" data-action="job-retry" data-id="${esc(job.id)}" data-source="${esc(job.source)}">重置重试</button>
                            <button type="button" class="btn btn-danger-ghost btn-xs" data-action="job-delete" data-id="${esc(job.id)}" data-source="${esc(job.source)}">删除</button>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `
}

/* ============================ 操作日志 ============================ */

async function loadAudit() {
    const container = $('auditTable')
    container.innerHTML = loadingState('加载操作日志…')
    const rows = await api.get('/api/audit-logs?limit=300')

    if (!rows.length) {
        container.innerHTML = emptyState('还没有操作记录', '挂起、终止、跳转、修改变量等操作会记录在这里')
        return
    }

    container.innerHTML = `
        <table class="table">
            <thead><tr><th>时间</th><th>操作</th><th>对象</th><th>说明</th></tr></thead>
            <tbody>
                ${rows.map((row) => `
                    <tr>
                        <td class="nowrap">${esc(fmtTime(row.created_at))}</td>
                        <td><span class="badge badge-slate">${esc(row.action)}</span></td>
                        <td><code>${esc(row.target || '—')}</code></td>
                        <td class="muted">${esc(row.detail || '—')}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
    `
}

/* ============================ 任务处理人弹层 ============================ */

async function openTaskModal(taskId, taskName, assignee) {
    state.modalTask = { id: taskId, name: taskName || '任务', assignee: assignee || '' }
    await refreshTaskModal()
}

async function refreshTaskModal() {
    const task = state.modalTask
    if (!task) return
    const links = await api.get(`/api/tasks/${enc(task.id)}/identitylinks`)

    const body = `
        <div class="field">
            <span>当前处理人</span>
            <div class="inline-form">
                <input id="taskAssigneeInput" list="userOptions" value="${esc(task.assignee)}" placeholder="用户ID 或从列表选择">
                <button type="button" class="btn btn-primary btn-sm" data-action="task-save-assignee">保存</button>
                <button type="button" class="btn btn-ghost btn-sm" data-action="task-clear-assignee">清空</button>
            </div>
            <p class="form-hint">${task.assignee ? esc(userHint(task.assignee)) : '未分配：任何拥有候选人权限的用户都可以认领'}</p>
        </div>
        <hr class="divider">
        <div class="field">
            <span>添加候选人 / 参与者</span>
            <div class="inline-form">
                <input id="candidateInput" list="userOptions" placeholder="用户ID">
                <select id="candidateType">
                    <option value="candidate">候选人</option>
                    <option value="participant">参与者</option>
                </select>
                <button type="button" class="btn btn-secondary btn-sm" data-action="candidate-add">添加</button>
            </div>
        </div>
        <div class="link-list">
            ${links.length ? links.map((link) => `
                <div class="link-item">
                    <span>
                        <strong>${esc(link.label || link.userId || link.groupId)}</strong>
                        <small>${esc(link.userId || link.groupId)} · ${link.type === 'candidate' ? '候选人' : link.type === 'participant' ? '参与者' : esc(link.type)}</small>
                    </span>
                    <button type="button" class="btn btn-danger-ghost btn-xs" data-action="candidate-remove"
                        data-user="${esc(link.userId || '')}" data-group="${esc(link.groupId || '')}" data-type="${esc(link.type || '')}">删除</button>
                </div>
            `).join('') : '<p class="muted">暂无候选人 / 参与者</p>'}
        </div>
    `

    const html = modalShell(`任务处理人 · ${task.name}`, body, '<button type="button" class="btn btn-secondary" data-action="modal-close">关闭</button>')
    openModal(html, 'md')
}

/* ============================ 变量弹层 ============================ */

function openVariableModal(mode, variable) {
    const isEdit = mode === 'edit'
    const type = variable ? variable.type : 'string'
    const knownTypes = ['string', 'long', 'double', 'boolean', 'json']
    const options = knownTypes.includes(type) ? knownTypes : [...knownTypes, type]
    const value = variable ? formatVariableValue(variable) : ''

    const body = `
        <div class="form-grid">
            <label class="field">
                <span>变量名</span>
                <input id="varName" value="${esc(variable ? variable.name : '')}" ${isEdit ? 'readonly' : ''} placeholder="例如：approvalStatus">
            </label>
            <label class="field">
                <span>类型</span>
                <select id="varType">
                    ${options.map((item) => `<option value="${esc(item)}" ${item === type ? 'selected' : ''}>${esc(item)}</option>`).join('')}
                </select>
            </label>
        </div>
        <label class="field">
            <span>变量值</span>
            <textarea id="varValue" rows="4" placeholder="变量值">${esc(value)}</textarea>
            <p class="form-hint">boolean 填 true / false；long 为整数；json 需为合法 JSON；string 最长 4000 字符。</p>
        </label>
    `
    openModal(modalShell(isEdit ? '修改变量' : '新增变量', body, `
        <button type="button" class="btn btn-secondary" data-action="modal-close">取消</button>
        <button type="button" class="btn btn-primary" data-action="variable-save" data-mode="${isEdit ? 'edit' : 'add'}">保存</button>
    `))
}

/* ============================ 历史任务编辑 ============================ */

function openHistoryTaskModal(task) {
    const commentMeta = task.comment
        ? `最近一条：${esc(fmtTime(task.commentTime))}${task.commentUserLabel ? ` · ${esc(task.commentUserLabel)}` : ''}${task.commentCount > 1 ? ` · 共 ${task.commentCount} 条` : ''}`
        : '该任务暂无审批意见，填写后保存会新增一条'
    const body = `
        <div class="form-grid">
            <label class="field">
                <span>任务名称</span>
                <input id="historyName" value="${esc(task.name || '')}">
            </label>
            <label class="field">
                <span>审批人</span>
                <input id="historyAssignee" list="userOptions" value="${esc(task.assignee || '')}" placeholder="用户ID">
            </label>
        </div>
        <div class="form-grid">
            <label class="field">
                <span>审批时间</span>
                <input id="historyEndTime" type="datetime-local" value="${esc(toLocalInput(task.endTime))}">
            </label>
            <label class="field">
                <span>删除原因</span>
                <input id="historyDeleteReason" value="${esc(task.deleteReason || '')}" placeholder="可留空">
            </label>
        </div>
        <p class="form-hint">清空「审批时间」会将该历史任务标记为未完成，请谨慎操作。</p>
        <hr class="divider">
        <label class="field">
            <span>审批意见</span>
            <textarea id="historyComment" rows="4" maxlength="4000" placeholder="填写或修改该任务的审批意见">${esc(task.comment || '')}</textarea>
            <p class="form-hint">
                ${commentMeta}<br>
                留空并保存会删除该任务的审批意见；只修改审批意见表（act_hi_comment），不影响流程流转与审批时间。
            </p>
        </label>
    `
    openModal(modalShell('编辑历史审批记录', body, `
        <button type="button" class="btn btn-secondary" data-action="modal-close">取消</button>
        <button type="button" class="btn btn-primary" data-action="history-save" data-id="${esc(task.id)}">保存修改</button>
    `))
}

/* ============================ 流程图（可视化 / XML） ============================ */

// bpmn-js 按需加载：只有打开流程图时才拉取资源，避免拖慢首屏
const bpmnAssets = {
    cssLoaded: false,
    descriptor: null,
    bundles: {
        viewer: { src: 'vendor/bpmn-js/bpmn-navigated-viewer.production.min.js', ctor: null },
        modeler: { src: 'vendor/bpmn-js/bpmn-modeler.production.min.js', ctor: null }
    }
}

// 元素 -> 编辑器实例。使用 WeakMap，DOM 被替换后自动回收
const bpmnHosts = new WeakMap()

// Activiti moddle 描述符(定义处理人、候选人等扩展属性)全局缓存一份
async function loadActivitiDescriptor() {
    if (bpmnAssets.descriptor) return bpmnAssets.descriptor
    const response = await fetch('vendor/bpmn-js/activiti.json')
    if (!response.ok) throw new Error('Activiti 属性描述符加载失败')
    bpmnAssets.descriptor = await response.json()
    return bpmnAssets.descriptor
}

function loadBpmnStyles() {
    if (bpmnAssets.cssLoaded) return
    bpmnAssets.cssLoaded = true
    ;[
        'vendor/bpmn-js/bpmn-embedded.css',
        'vendor/bpmn-js/bpmn-js.css',
        'vendor/bpmn-js/diagram-js.css'
    ].forEach((href) => {
        const link = document.createElement('link')
        link.rel = 'stylesheet'
        link.href = href
        document.head.appendChild(link)
    })
}

function loadBpmnScript(src) {
    return new Promise((resolve, reject) => {
        const script = document.createElement('script')
        script.src = src
        script.onload = () => resolve()
        script.onerror = () => reject(new Error('流程图组件加载失败，请确认 vendor/bpmn-js 目录完整'))
        document.head.appendChild(script)
    })
}

async function loadBpmnBundle(kind) {
    const bundle = bpmnAssets.bundles[kind]
    if (bundle.ctor) return bundle.ctor
    loadBpmnStyles()
    await loadBpmnScript(bundle.src)
    // viewer 与 modeler 两个 UMD 包都会挂到 window.BpmnJS 上，加载后立即缓存，避免互相覆盖
    bundle.ctor = window.BpmnJS
    if (!bundle.ctor) throw new Error('流程图组件初始化失败')
    return bundle.ctor
}

function bpmnEditorMarkup(options = {}) {
    const { definitionId = '', editable = true, mode = 'graph', xml = '', saveText = '保存修改', showActions = true } = options
    return `
        <div class="bpmn-editor" data-bpmn-editor data-definition-id="${esc(definitionId)}" data-bpmn-editable="${editable ? '1' : '0'}">
            <div class="bpmn-toolbar">
                <div class="segmented">
                    <button type="button" class="${mode === 'graph' ? 'is-active' : ''}" data-action="bpmn-mode" data-mode="graph">图形</button>
                    <button type="button" class="${mode === 'xml' ? 'is-active' : ''}" data-action="bpmn-mode" data-mode="xml">XML</button>
                </div>
                <span class="bpmn-dirty" data-bpmn-dirty hidden>未保存</span>
                <span class="spacer"></span>
                <button type="button" class="btn btn-ghost btn-sm" data-action="bpmn-fit" ${mode === 'graph' ? '' : 'hidden'}>适应画布</button>
                <button type="button" class="btn btn-ghost btn-sm" data-action="bpmn-copy">复制 XML</button>
                ${editable && showActions ? `<button type="button" class="btn btn-secondary btn-sm" data-action="bpmn-reset">重置</button>
                <button type="button" class="btn btn-primary btn-sm" data-action="bpmn-save">${esc(saveText)}</button>` : ''}
            </div>
            <div class="bpmn-pane" data-bpmn-pane="graph" ${mode === 'graph' ? '' : 'hidden'}>
                <div class="bpmn-canvas" data-bpmn-canvas></div>
                ${editable ? '<aside class="bpmn-props" data-bpmn-props></aside>' : ''}
            </div>
            <div class="bpmn-pane" data-bpmn-pane="xml" ${mode === 'xml' ? '' : 'hidden'}>
                <textarea class="code-editor" data-bpmn-xml spellcheck="false" ${editable ? '' : 'readonly'}>${esc(xml)}</textarea>
            </div>
            ${editable ? '<p class="form-hint">图形模式支持拖拽调整布局、增删节点与连线；选中节点或连线后可在右侧属性面板设置处理人、候选人、表单、条件表达式等。切换「图形 / XML」不会丢失修改，保存前请确认。</p>' : ''}
        </div>
    `
}

function bpmnHostOf(el) {
    if (!el) return null
    // 弹层工具栏里的按钮在编辑器之外，需要从所属容器里找回编辑器根节点
    const root = el.closest('[data-bpmn-editor]')
        || (el.closest('#modalRoot, #drawerRoot') || document).querySelector('[data-bpmn-editor]')
    return root ? bpmnHosts.get(root) : null
}

function setBpmnDirty(host, dirty) {
    host.dirty = Boolean(dirty)
    const badge = host.root.querySelector('[data-bpmn-dirty]')
    if (badge) badge.hidden = !host.dirty
}

function fitBpmn(host) {
    if (!host || !host.instance) return
    try {
        const canvas = host.instance.get('canvas')
        canvas.zoom('fit-viewport')
        if (host.editable) {
            // 左侧工具面板会压住图形，向左扩展视口给它留出空间
            const viewbox = canvas.viewbox()
            canvas.viewbox({
                x: viewbox.x - 70,
                y: viewbox.y - 20,
                width: viewbox.width + 70,
                height: viewbox.height + 20
            })
        }
    } catch (error) {
        console.warn('[BPMN] fit failed:', error)
    }
}

/* ---- 右侧属性面板 ---- */

// 元素类型的中文名，用于属性面板标题
const BPMN_TYPE_LABELS = {
    'bpmn:Process': '流程',
    'bpmn:UserTask': '用户任务',
    'bpmn:ManualTask': '手工任务',
    'bpmn:ServiceTask': '服务任务',
    'bpmn:ScriptTask': '脚本任务',
    'bpmn:BusinessRuleTask': '规则任务',
    'bpmn:SendTask': '发送任务',
    'bpmn:ReceiveTask': '接收任务',
    'bpmn:CallActivity': '调用子流程',
    'bpmn:SubProcess': '子流程',
    'bpmn:StartEvent': '开始事件',
    'bpmn:EndEvent': '结束事件',
    'bpmn:IntermediateCatchEvent': '中间捕获事件',
    'bpmn:IntermediateThrowEvent': '中间抛出事件',
    'bpmn:BoundaryEvent': '边界事件',
    'bpmn:ExclusiveGateway': '排他网关',
    'bpmn:ParallelGateway': '并行网关',
    'bpmn:InclusiveGateway': '包容网关',
    'bpmn:EventBasedGateway': '事件网关',
    'bpmn:SequenceFlow': '连线',
    'bpmn:TextAnnotation': '文本注释',
    'bpmn:Lane': '泳道'
}

function bpmnTypeLabel(bo) {
    if (!bo || !bo.$type) return ''
    return BPMN_TYPE_LABELS[bo.$type] || bo.$type.replace(/^bpmn:/, '')
}

// 按元素类型列出可编辑的 Activiti 扩展属性，key 即 moddle 属性名
function bpmnPropFields(bo) {
    if (!bo || typeof bo.$instanceOf !== 'function') return []
    if (bo.$type === 'bpmn:SequenceFlow') {
        return [
            { key: 'name', label: '连线名称', kind: 'text' },
            {
                key: 'conditionExpression',
                label: '条件表达式',
                kind: 'code',
                hint: '留空表示无条件，可使用 ${...} 形式引用流程变量',
                placeholder: '${approved == true}'
            }
        ]
    }
    const fields = []
    if (bo.$instanceOf('bpmn:FlowElement') || bo.$instanceOf('bpmn:Process')) {
        fields.push({ key: 'name', label: '名称', kind: 'text' })
    }
    if (bo.$instanceOf('bpmn:UserTask')) {
        fields.push(
            { key: 'assignee', label: '处理人', kind: 'user', placeholder: '用户名，如 zhangsan' },
            { key: 'candidateUsers', label: '候选人', kind: 'users', placeholder: '多个用户名用英文逗号分隔' },
            { key: 'candidateGroups', label: '候选组', kind: 'text', placeholder: '多个组用英文逗号分隔' },
            { key: 'dueDate', label: '到期时间', kind: 'text', placeholder: '如 2026-12-31T18:00:00' },
            { key: 'priority', label: '优先级', kind: 'text', placeholder: '整数，默认 50' },
            { key: 'formKey', label: '表单 Key', kind: 'text', placeholder: '关联的表单标识' }
        )
    } else if (bo.$instanceOf('bpmn:ServiceTask') || bo.$instanceOf('bpmn:BusinessRuleTask') || bo.$instanceOf('bpmn:SendTask')) {
        fields.push(
            { key: 'class', label: 'Java 类', kind: 'text', placeholder: 'com.example.MyDelegate' },
            { key: 'delegateExpression', label: '委托表达式', kind: 'text', placeholder: '${myDelegate}' },
            { key: 'expression', label: '表达式', kind: 'text', placeholder: '${myService.run()}' },
            { key: 'resultVariable', label: '结果变量', kind: 'text', placeholder: '保存返回值的变量名' }
        )
    } else if (bo.$instanceOf('bpmn:ScriptTask')) {
        fields.push(
            { key: 'resultVariable', label: '结果变量', kind: 'text', placeholder: '保存脚本结果的变量名' },
            { key: 'resource', label: '脚本资源', kind: 'text', placeholder: '流程资源路径' }
        )
    } else if (bo.$instanceOf('bpmn:StartEvent')) {
        fields.push(
            { key: 'initiator', label: '发起人变量', kind: 'text', placeholder: '记录发起人的变量名，如 initiator' },
            { key: 'formKey', label: '表单 Key', kind: 'text', placeholder: '关联的表单标识' }
        )
    } else if (bo.$instanceOf('bpmn:Process')) {
        fields.push(
            { key: 'candidateStarterUsers', label: '候选发起人', kind: 'users', placeholder: '多个用户名用英文逗号分隔' },
            { key: 'candidateStarterGroups', label: '候选发起组', kind: 'text', placeholder: '多个组用英文逗号分隔' },
            { key: 'versionTag', label: '版本标签', kind: 'text' }
        )
    }
    // 活动、网关、事件都支持异步执行
    if (bo.$instanceOf('bpmn:Activity') || bo.$instanceOf('bpmn:Gateway') || bo.$instanceOf('bpmn:Event')) {
        fields.push({ key: 'async', label: '异步执行', kind: 'bool', hint: '勾选后由作业执行器异步处理' })
    }
    return fields
}

function bpmnSelectedElements(host) {
    if (!host || !host.instance) return []
    try {
        return host.instance.get('selection').get() || []
    } catch (error) {
        return []
    }
}

function bpmnPropValue(bo, key) {
    if (!bo) return ''
    const value = typeof bo.get === 'function' ? bo.get(key) : bo[key]
    if (value === null || value === undefined) return ''
    if (key === 'conditionExpression') return value.body || ''
    return value
}

// 处理人 / 候选人字段附上 sys_user 解析结果
function bpmnPropHint(field, value) {
    if (value === '' || value === null || value === undefined || value === false) return null
    if (field.kind === 'user') {
        const text = userHint(value)
        return text ? { text: `当前解析：${text}`, warn: text.indexOf('未在') === 0 } : null
    }
    if (field.kind === 'users') {
        const names = String(value).split(',').map((item) => item.trim()).filter(Boolean)
        if (!names.length) return null
        const missing = names.filter((name) => !state.userIndex.has(name))
        return {
            text: `当前解析：${names.map((name) => userLabel(name)).join('、')}`,
            warn: missing.length > 0
        }
    }
    return field.hint ? { text: field.hint, warn: false } : null
}

function bpmnPropFieldHtml(bo, field) {
    const value = bpmnPropValue(bo, field.key)
    const id = `bpmnProp-${field.key}`
    const hint = bpmnPropHint(field, value)
    const hintHtml = hint ? `<span class="bpmn-field-hint${hint.warn ? ' is-warn' : ''}">${esc(hint.text)}</span>` : ''

    if (field.kind === 'bool') {
        return `
            <div class="bpmn-field bpmn-field-check">
                <input type="checkbox" id="${id}" data-bpmn-prop="${esc(field.key)}" data-bpmn-kind="bool" ${value === true || value === 'true' ? 'checked' : ''}>
                <label for="${id}">${esc(field.label)}</label>
            </div>
            ${hintHtml}
        `
    }
    if (field.kind === 'code') {
        return `
            <div class="bpmn-field">
                <label for="${id}">${esc(field.label)}</label>
                <textarea id="${id}" spellcheck="false" data-bpmn-prop="${esc(field.key)}" data-bpmn-kind="code" placeholder="${esc(field.placeholder || '')}">${esc(String(value))}</textarea>
                ${hintHtml}
            </div>
        `
    }
    const list = field.kind === 'user' || field.kind === 'users' ? ' list="userOptions"' : ''
    return `
        <div class="bpmn-field">
            <label for="${id}">${esc(field.label)}</label>
            <input type="text" id="${id}" value="${esc(String(value))}"${list} data-bpmn-prop="${esc(field.key)}" data-bpmn-kind="${esc(field.kind)}" placeholder="${esc(field.placeholder || '')}">
            ${hintHtml}
        </div>
    `
}

function renderBpmnProps(host) {
    if (!host || !host.editable) return
    const propsEl = host.root.querySelector('[data-bpmn-props]')
    if (!propsEl) return
    const selected = bpmnSelectedElements(host)
    if (!selected.length) {
        propsEl.innerHTML = '<div class="bpmn-props-empty">点击图形中的节点或连线，在这里设置处理人、候选人、条件等属性。</div>'
        return
    }
    const bo = selected[0].businessObject
    const fields = bpmnPropFields(bo)
    propsEl.innerHTML = `
        <div class="bpmn-props-head">
            <strong>${esc(bo.name || bo.id || '未命名')}</strong>
            <span class="badge badge-slate">${esc(bpmnTypeLabel(bo))}</span>
        </div>
        <div class="bpmn-props-body">
            ${fields.length
                ? fields.map((field) => bpmnPropFieldHtml(bo, field)).join('')
                : '<span class="bpmn-field-hint">该元素暂无可编辑的扩展属性，可切换到 XML 模式编辑。</span>'}
            ${selected.length > 1 ? '<span class="bpmn-field-hint">已选择多个元素，这里只显示第一个。</span>' : ''}
        </div>
    `
}

function commitBpmnProp(host, key, kind, value) {
    if (!host || !host.editable) return
    const element = bpmnSelectedElements(host)[0]
    if (!element) return
    const modeling = host.instance.get('modeling')
    if (key === 'conditionExpression') {
        const moddle = host.instance.get('moddle')
        modeling.updateProperties(element, {
            conditionExpression: value ? moddle.create('bpmn:FormalExpression', { body: value }) : undefined
        })
        return
    }
    // 复选框取消勾选、文本框清空时传 undefined，让 moddle 移除该属性
    const next = kind === 'bool' ? (value === true ? true : undefined) : (value === '' ? undefined : value)
    modeling.updateProperties(element, { [key]: next })
}

function setBpmnModeUI(host, mode) {
    host.mode = mode
    host.root.querySelectorAll('[data-action="bpmn-mode"]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.mode === mode)
    })
    host.root.querySelectorAll('[data-bpmn-pane]').forEach((pane) => {
        pane.hidden = pane.dataset.bpmnPane !== mode
    })
    const fitBtn = host.root.querySelector('[data-action="bpmn-fit"]')
    if (fitBtn) fitBtn.hidden = mode !== 'graph'
    if (mode === 'graph') {
        // 图形面板可能刚从隐藏状态显示出来，先让 bpmn-js 重新测量容器尺寸
        if (host.instance) {
            try {
                host.instance.get('canvas').resized()
            } catch (error) {
                console.warn('[BPMN] resize failed:', error)
            }
        }
        fitBpmn(host)
        renderBpmnProps(host)
    }
}

async function bpmnCurrentXml(host) {
    if (!host) return ''
    if (host.mode === 'xml') return host.textarea.value
    // 只读实例（navigated-viewer）没有 saveXML，直接返回原始 XML
    if (!host.editable) return host.baseline
    const result = await host.instance.saveXML({ format: true })
    return result.xml
}

async function mountBpmnEditor(root, options = {}) {
    if (!root) return null
    const editable = options.editable !== false
    const xml = options.xml || ''
    const canvasEl = root.querySelector('[data-bpmn-canvas]')
    const textarea = root.querySelector('[data-bpmn-xml]')
    // 初始模式以标记中的可见面板为准，避免与 state.detailDiagramMode 不一致
    const visiblePane = Array.prototype.slice.call(root.querySelectorAll('[data-bpmn-pane]')).find((pane) => !pane.hidden)
    const initialMode = visiblePane ? visiblePane.dataset.bpmnPane : 'graph'

    const host = {
        root,
        textarea,
        editable,
        instance: null,
        mode: initialMode,
        baseline: xml,
        exportedXml: '',
        dirty: false,
        destroyed: false,
        definitionId: root.dataset.definitionId || '',
        onSaved: options.onSaved || null
    }
    bpmnHosts.set(root, host)
    if (textarea) textarea.value = xml

    const Ctor = await loadBpmnBundle(editable ? 'modeler' : 'viewer')
    if (host.destroyed) return host

    const instanceOptions = { container: canvasEl }
    // 注入 Activiti 描述符后，assignee / candidateUsers 等成为一级属性，可被属性面板读写
    if (editable) instanceOptions.moddleExtensions = { activiti: await loadActivitiDescriptor() }
    if (host.destroyed) return host

    const instance = new Ctor(instanceOptions)
    host.instance = instance

    if (editable) {
        instance.on('commandStack.changed', () => {
            setBpmnDirty(host, true)
            const propsEl = root.querySelector('[data-bpmn-props]')
            // 面板里正在输入时不重绘，避免打断输入
            if (!propsEl || !propsEl.contains(document.activeElement)) renderBpmnProps(host)
        })
        instance.on('selection.changed', () => renderBpmnProps(host))
        if (textarea) {
            textarea.addEventListener('input', () => {
                // 与原始 XML 比较，改回原样时自动消除「未保存」标记
                setBpmnDirty(host, textarea.value.trim() !== host.baseline.trim())
            })
        }
    }

    // 属性面板只处理 change 事件：文本在失焦或回车时提交，复选框点击即提交
    const propsEl = root.querySelector('[data-bpmn-props]')
    if (propsEl) {
        propsEl.addEventListener('change', (event) => {
            const input = event.target.closest('[data-bpmn-prop]')
            if (!input) return
            const kind = input.dataset.bpmnKind
            commitBpmnProp(host, input.dataset.bpmnProp, kind, kind === 'bool' ? input.checked : input.value.trim())
        })
    }

    try {
        await instance.importXML(xml)
    } catch (error) {
        // 缺少 BPMNDiagram / 坐标信息的旧流程无法渲染，退化为 XML 编辑
        console.warn('[BPMN] import failed:', error)
        setBpmnModeUI(host, 'xml')
        toast(`流程图无法渲染：${error.message}，已切换到 XML 模式`, 'error')
        return host
    }

    if (host.mode === 'graph') fitBpmn(host)
    renderBpmnProps(host)
    return host
}

async function switchBpmnMode(host, mode) {
    if (!host || host.mode === mode) return
    if (mode === 'xml') {
        if (host.editable) {
            try {
                const result = await host.instance.saveXML({ format: true })
                host.exportedXml = result.xml
                host.textarea.value = result.xml
            } catch (error) {
                toast(`获取 XML 失败：${error.message}`, 'error')
                return
            }
        }
        setBpmnModeUI(host, 'xml')
        host.textarea.focus()
        host.textarea.scrollTop = 0
        return
    }

    const xml = host.textarea.value.trim()
    if (!xml) {
        toast('XML 内容不能为空', 'error')
        return
    }
    // 内容未变化时只切换视图，避免无谓地重置画布与撤销栈
    if (host.editable && xml !== host.exportedXml.trim()) {
        try {
            await host.instance.importXML(xml)
        } catch (error) {
            toast(`XML 解析失败：${error.message}`, 'error')
            return
        }
        host.exportedXml = xml
    }
    setBpmnModeUI(host, 'graph')
}

async function resetBpmnHost(host) {
    if (!host || !host.editable) return
    try {
        await host.instance.importXML(host.baseline)
        host.textarea.value = host.baseline
        host.exportedXml = ''
        setBpmnDirty(host, false)
        if (host.mode === 'graph') {
            try {
                host.instance.get('canvas').resized()
            } catch (error) {
                console.warn('[BPMN] resize failed:', error)
            }
            fitBpmn(host)
        }
        renderBpmnProps(host)
        toast('已恢复为最近一次保存的内容', 'info')
    } catch (error) {
        toast(`重置失败：${error.message}`, 'error')
    }
}

async function saveBpmnHost(host, el) {
    if (!host || !host.editable) return
    const xml = (await bpmnCurrentXml(host)).trim()
    if (!xml) {
        toast('XML 内容不能为空', 'error')
        return
    }
    if (!/<(?:\w+:)?definitions[\s>]/.test(xml) || !/<(?:\w+:)?process[\s>]/.test(xml)) {
        toast('XML 内容不完整：必须包含 definitions 与 process 节点', 'error')
        return
    }
    const ok = await askDialog({
        title: '保存流程定义 XML',
        message: '修改会覆盖该部署的 BPMN 资源，影响后续所有新建实例。<br>正在运行的实例不会自动迁移，确定保存吗？',
        confirmText: '确认保存',
        danger: true
    })
    if (ok === null) return

    await withBusy(el, () => api.put(`/api/definitions/${enc(host.definitionId)}/xml`, { xml }))
    host.baseline = xml
    host.textarea.value = xml
    // XML 模式下保存后画布还是旧图，清空标记以便切回图形时重新导入
    host.exportedXml = host.mode === 'xml' ? '' : xml
    setBpmnDirty(host, false)
    state.xmlOriginal = xml
    toast('流程图已保存', 'success')
    if (host.onSaved) await host.onSaved(xml)
}

async function copyBpmnXml(host) {
    if (!host) return
    try {
        const xml = await bpmnCurrentXml(host)
        await navigator.clipboard.writeText(xml)
        toast('XML 已复制到剪贴板', 'success')
    } catch (error) {
        toast('复制失败，请手动选择文本', 'error')
    }
}

function destroyBpmnHost(root) {
    const host = root ? bpmnHosts.get(root) : null
    if (!host) return
    host.destroyed = true
    bpmnHosts.delete(root)
    if (host.instance) {
        try {
            host.instance.destroy()
        } catch (error) {
            console.warn('[BPMN] destroy failed:', error)
        }
    }
    host.instance = null
}

// 有未保存修改时，离开前二次确认
async function confirmDiscardBpmn(root) {
    const host = root ? bpmnHosts.get(root) : null
    if (!host || !host.dirty) return true
    const ok = await askDialog({
        title: '放弃未保存的修改',
        message: '当前流程图有未保存的修改，离开后这些修改会丢失。',
        confirmText: '放弃修改',
        danger: true
    })
    return ok !== null
}

async function openXmlModal(definitionId, editable) {
    const data = await api.get(`/api/definitions/${enc(definitionId)}/xml`)
    const definition = data.definition || {}
    state.xmlOriginal = data.xml || ''
    let affected = { total: 0 }
    try {
        affected = await api.get(`/api/definitions/${enc(definitionId)}/affected-instances`)
    } catch (error) {
        affected = { total: 0 }
    }

    const warning = affected.total > 0
        ? `<div class="notice notice-warn">
               <strong>该定义已关联 ${fmtNumber(affected.total)} 个历史实例</strong>
               <span>修改只会覆盖部署资源，不会迁移已经运行的实例。</span>
           </div>`
        : '<div class="notice notice-info">该流程定义暂无关联的历史实例。</div>'

    const body = `
        <div class="xml-meta">
            <span>${esc(definition.name || definition.key || '')}</span>
            <span class="badge badge-slate">v${esc(definition.version || '?')}</span>
            <span class="mono">${esc(definition.resourceName || '')}</span>
        </div>
        ${warning}
        ${bpmnEditorMarkup({
            definitionId,
            editable,
            mode: 'graph',
            xml: data.xml || '',
            showActions: false
        })}
    `
    const footer = editable
        ? `<button type="button" class="btn btn-secondary" data-action="modal-close">取消</button>
           <button type="button" class="btn btn-ghost" data-action="bpmn-reset">重置</button>
           <button type="button" class="btn btn-primary" data-action="bpmn-save">保存修改</button>`
        : `<button type="button" class="btn btn-secondary" data-action="modal-close">关闭</button>
           <button type="button" class="btn btn-primary" data-action="xml-edit" data-id="${esc(definitionId)}">编辑</button>`

    openModal(modalShell(editable ? '编辑流程图' : '查看流程图', body, footer), 'xl')

    const root = $('modalRoot').querySelector('[data-bpmn-editor]')
    await mountBpmnEditor(root, {
        xml: data.xml || '',
        editable,
        onSaved: async () => {
            closeModal()
            state.definitions = await api.get('/api/definitions')
            if (state.view === 'definitions') await loadDefinitionsView()
            if (state.detail && state.detailTab === 'xml') {
                state.detailData.xml = state.xmlOriginal
                renderDrawer()
            }
        }
    }).catch((error) => {
        toast(error.message, 'error')
    })
}

async function openNodePicker() {
    const detail = state.detail
    if (!detail || !detail.procDefId) {
        toast('缺少流程定义信息', 'error')
        return
    }
    const data = await api.get(`/api/definitions/${enc(detail.procDefId)}/nodes`)
    const nodes = (data.nodes || []).filter((node) => node.type === 'userTask')

    const body = nodes.length
        ? `
            <p class="muted">选择要跳转到的用户任务节点。跳转后当前任务会被删除，并按节点配置重新分配处理人 / 候选人。</p>
            <div class="node-list">
                ${nodes.map((node, index) => `
                    <label class="node-item">
                        <input type="radio" name="targetNode" value="${esc(node.id)}" ${index === 0 ? 'checked' : ''}>
                        <span class="node-main">
                            <strong>${esc(node.name || node.id)}</strong>
                            <small><code>${esc(node.id)}</code></small>
                        </span>
                        <span class="node-side">
                            ${node.assignee ? `处理人 ${esc(node.assignee)}` : ''}
                            ${node.candidateGroups ? `候选组 ${esc(node.candidateGroups)}` : ''}
                            ${node.candidateUsers ? `候选人 ${esc(node.candidateUsers)}` : ''}
                            ${!node.assignee && !node.candidateGroups && !node.candidateUsers ? '未配置处理人' : ''}
                        </span>
                    </label>
                `).join('')}
            </div>
            ${detail.isFinished ? '<div class="notice notice-warn">该实例已结束，跳转后会重新激活流程。</div>' : ''}
        `
        : emptyState('该流程定义中没有用户任务节点')

    openModal(modalShell('跳转到节点', body, `
        <button type="button" class="btn btn-secondary" data-action="modal-close">取消</button>
        <button type="button" class="btn btn-primary" data-action="node-jump" ${nodes.length ? '' : 'disabled'}>执行跳转</button>
    `), 'md')
}

async function openDefinitionNodes(definitionId) {
    const data = await api.get(`/api/definitions/${enc(definitionId)}/nodes`)
    const nodes = data.nodes || []
    const body = nodes.length
        ? `<ul class="compact-list">${nodes.map((node) => `
            <li>
                <div class="compact-row is-static">
                    <span class="compact-main">
                        <strong>${esc(node.name || node.id)}</strong>
                        <span><code>${esc(node.id)}</code>${node.assignee ? ` · 处理人 ${esc(node.assignee)}` : ''}${node.candidateGroups ? ` · 候选组 ${esc(node.candidateGroups)}` : ''}</span>
                    </span>
                    <span class="badge badge-slate">${esc(nodeTypeLabel(node.type))}</span>
                </div>
            </li>`).join('')}</ul>`
        : emptyState('未解析到节点')
    openModal(modalShell('流程节点', body, '<button type="button" class="btn btn-secondary" data-action="modal-close">关闭</button>'), 'md')
}

async function openMigrateModal() {
    const detail = state.detail
    if (!detail) return
    if (!state.definitions.length) await ensureDefinitions()
    const candidates = state.definitions.filter((definition) =>
        definition.key === detail.procDefKey && definition.id !== detail.procDefId
    )

    const body = candidates.length
        ? `
            <p class="muted">仅列出同一流程 Key 的其他版本。迁移只修改运行中实例引用的流程定义，已生成的节点状态保持不变，请确认版本兼容。</p>
            <div class="node-list">
                ${candidates.map((definition, index) => `
                    <label class="node-item">
                        <input type="radio" name="migrateTarget" value="${esc(definition.id)}" ${index === 0 ? 'checked' : ''} ${definition.suspended ? 'disabled' : ''}>
                        <span class="node-main">
                            <strong>v${esc(definition.version)} · ${esc(definition.name || definition.key)}</strong>
                            <small><code>${esc(definition.id)}</code></small>
                        </span>
                        <span class="node-side">${definition.suspended ? '已挂起' : esc(fmtTime(definition.deployTime))}</span>
                    </label>
                `).join('')}
            </div>
        `
        : emptyState('没有可迁移的其他版本', '同一 Key 下需要先部署新版本')

    openModal(modalShell('变更流程版本', body, `
        <button type="button" class="btn btn-secondary" data-action="modal-close">取消</button>
        <button type="button" class="btn btn-primary" data-action="migrate-confirm" ${candidates.length ? '' : 'disabled'}>确认迁移</button>
    `), 'md')
}

/* ============================ 动作注册 ============================ */

const actions = {
    /* ---- 弹层 ---- */
    'modal-close': async () => {
        if (!await confirmDiscardBpmn(document.querySelector('#modalRoot [data-bpmn-editor]'))) return
        closeModal(null)
    },
    'dialog-cancel': () => closeDialog(null),
    'dialog-confirm': () => {
        const input = $('dialogInput')
        closeDialog(input ? input.value : true)
    },

    /* ---- 连接页 ---- */
    'conn-new': () => resetConnectionForm(),
    'conn-pick': (el) => pickConnection(Number(el.dataset.id)),
    'conn-delete': (el) => deleteSavedConnection(Number(el.dataset.id)),
    'conn-load-databases': (el) => loadDatabaseList(false),
    'conn-test': (el) => testConnection(el),
    'conn-save': (el) => saveConnection(el),
    'conn-connect': (el) => connectDatabase(el),

    'switch-database': async () => {
        const ok = await askDialog({
            title: '切换数据库',
            message: '切换会断开当前数据库连接，并返回连接页面。确定继续吗？',
            confirmText: '断开并切换'
        })
        if (ok === null) return
        await api.post('/api/disconnect')
        state.connected = false
        closeDrawer()
        await checkConnection()
    },
    disconnect: async () => {
        const ok = await askDialog({
            title: '断开连接',
            message: '断开后需要重新连接数据库才能继续操作。确定断开吗？',
            confirmText: '断开'
        })
        if (ok === null) return
        await api.post('/api/disconnect')
        state.connected = false
        state.connection = null
        state.definitions = []
        state.users = []
        closeDrawer()
        showConnectionScreen()
        toast('已断开数据库连接', 'info')
    },

    /* ---- 视图 ---- */
    'refresh-view': () => loadView(state.view),

    /* ---- 实例 ---- */
    'open-instance': (el) => openInstance(el.dataset.id),
    'close-drawer': async () => {
        if (!await confirmDiscardBpmn(document.querySelector('#drawerRoot [data-bpmn-editor]'))) return
        closeDrawer()
    },
    'instance-refresh': async () => {
        if (!await confirmDiscardBpmn(document.querySelector('#drawerRoot [data-bpmn-editor]'))) return
        await reloadDetail()
    },
    'instance-page': (el) => {
        state.instancePage = Number(el.dataset.page) || 1
        loadInstances().catch(handleError)
    },
    'instance-status': (el) => {
        state.instanceStatus = el.dataset.status
        state.instancePage = 1
        document.querySelectorAll('#instanceStatusTabs button').forEach((button) => {
            button.classList.toggle('is-active', button.dataset.status === state.instanceStatus)
        })
        loadInstances().catch(handleError)
    },
    'instance-quick-toggle': async (el) => {
        const suspended = el.dataset.suspended === '1'
        await withBusy(el, () => api.post(`/api/instances/${enc(el.dataset.id)}/${suspended ? 'activate' : 'suspend'}`))
        toast(suspended ? '实例已激活' : '实例已挂起', 'success')
        await loadInstances()
        if (state.view === 'overview') await loadOverview()
    },
    'instance-terminate': async (el) => {
        const id = el.dataset.id || state.detailId
        const reason = await askDialog({
            title: '终止流程实例',
            message: `终止会删除该实例的运行时数据（任务、变量、作业），并保留历史记录。<br>实例ID：<code>${esc(id)}</code>`,
            label: '终止原因',
            value: '运维工具终止流程',
            confirmText: '确认终止',
            danger: true
        })
        if (reason === null) return
        const data = await api.post(`/api/instances/${enc(id)}/terminate`, { reason })
        toast('流程实例已终止', 'success')
        if (state.detailId === id) await reloadDetail()
        if (state.view === 'instances') await loadInstances()
        if (state.view === 'overview') await loadOverview()
        if (data && data.warnings && data.warnings.length) {
            data.warnings.forEach((warning) => toast(warning, 'info'))
        }
    },
    'instance-purge': async (el) => {
        const id = el.dataset.id || state.detailId
        const ok = await askDialog({
            title: '彻底删除流程实例',
            message: `将永久删除实例 <code>${esc(id)}</code> 的<strong>运行时数据与全部历史记录</strong>（任务、变量、轨迹、评论）。<br>此操作不可撤销，通常只用于清理测试数据。`,
            confirmText: '确认彻底删除',
            danger: true
        })
        if (ok === null) return
        await api.delete(`/api/instances/${enc(id)}`)
        toast('实例及历史数据已删除', 'success')
        closeDrawer()
        if (state.view === 'instances') await loadInstances()
        if (state.view === 'overview') await loadOverview()
    },
    'instance-toggle': async (el) => {
        const detail = state.detail
        if (!detail) return
        const suspended = Number(detail.suspensionState) === 2
        await withBusy(el, () => api.post(`/api/instances/${enc(detail.id)}/${suspended ? 'activate' : 'suspend'}`))
        toast(suspended ? '实例已激活' : '实例已挂起', 'success')
        await reloadDetail()
        if (state.view === 'instances') await loadInstances()
    },
    'instance-migrate': () => openMigrateModal().catch(handleError),
    'migrate-confirm': async (el) => {
        const selected = document.querySelector('input[name="migrateTarget"]:checked')
        if (!selected) {
            toast('请选择目标版本', 'error')
            return
        }
        await withBusy(el, () => api.post(`/api/instances/${enc(state.detail.id)}/migrate`, { definitionId: selected.value }))
        closeModal()
        toast('流程版本已变更', 'success')
        await reloadDetail()
        if (state.view === 'instances') await loadInstances()
    },
    'instance-jump-node': () => openNodePicker().catch(handleError),
    'node-jump': async (el) => {
        const selected = document.querySelector('input[name="targetNode"]:checked')
        if (!selected) {
            toast('请选择目标节点', 'error')
            return
        }
        const data = await withBusy(el, () => api.post(`/api/instances/${enc(state.detail.id)}/jump-to-activity`, { activityId: selected.value }))
        closeModal()
        toast('已跳转到目标节点', 'success')
        await reloadDetail()
        if (state.view === 'instances') await loadInstances()
        if (data && data.warnings) data.warnings.forEach((warning) => toast(warning, 'info'))
    },

    /* ---- 详情弹窗标签 ---- */
    'drawer-tab': async (el) => {
        const nextTab = el.dataset.tab
        if (nextTab === state.detailTab) return
        // 离开流程图标签页前，检查是否有未保存的图形编辑
        if (state.detailTab === 'xml' && !await confirmDiscardBpmn(document.querySelector('#drawerRoot [data-bpmn-editor]'))) return
        state.detailTab = nextTab
        if (state.detailTab === 'xml') {
            try {
                await ensureDrawerXml()
            } catch (error) {
                toast(error.message, 'error')
                state.detailData.xml = ''
            }
        }
        renderDrawer()
    },

    /* ---- 流程图 ---- */
    'bpmn-mode': async (el) => {
        const host = bpmnHostOf(el)
        if (!host) return
        if (host.root.closest('#drawerRoot')) state.detailDiagramMode = el.dataset.mode === 'xml' ? 'xml' : 'graph'
        await switchBpmnMode(host, el.dataset.mode === 'xml' ? 'xml' : 'graph')
    },
    'bpmn-fit': (el) => fitBpmn(bpmnHostOf(el)),
    'bpmn-reset': (el) => resetBpmnHost(bpmnHostOf(el)),
    'bpmn-save': (el) => saveBpmnHost(bpmnHostOf(el), el),
    'bpmn-copy': (el) => copyBpmnXml(bpmnHostOf(el)),

    /* ---- 变量 ---- */
    'variable-add': () => openVariableModal('add', null),
    'variable-edit': (el) => {
        const variable = state.detailData.variables.find((item) => item.name === el.dataset.name)
        if (variable) openVariableModal('edit', variable)
    },
    'variable-save': async (el) => {
        const name = $('varName').value.trim()
        const type = $('varType').value
        const value = $('varValue').value
        if (!name) {
            toast('请填写变量名', 'error')
            return
        }
        await withBusy(el, () => api.post(`/api/instances/${enc(state.detail.id)}/variables`, { name, type, value }))
        closeModal()
        toast('变量已保存', 'success')
        await reloadDetail()
    },
    'variable-delete': async (el) => {
        const ok = await askDialog({
            title: '删除变量',
            message: `确定删除变量 <code>${esc(el.dataset.name)}</code> 吗？运行时与历史变量都会删除。`,
            confirmText: '删除',
            danger: true
        })
        if (ok === null) return
        await api.delete(`/api/instances/${enc(state.detail.id)}/variables/${enc(el.dataset.name)}`)
        toast('变量已删除', 'success')
        await reloadDetail()
    },

    /* ---- 历史任务 ---- */
    'history-edit': (el) => {
        const task = state.detailData.history.find((item) => item.id === el.dataset.id)
        if (task) openHistoryTaskModal(task)
    },
    'history-save': async (el) => {
        const endTime = $('historyEndTime').value
        const commentField = $('historyComment')
        const result = await withBusy(el, () => api.put(`/api/history-tasks/${enc(el.dataset.id)}`, {
            name: $('historyName').value,
            assignee: $('historyAssignee').value.trim(),
            endTime: endTime ? new Date(endTime).toISOString() : null,
            deleteReason: $('historyDeleteReason').value,
            comment: commentField ? commentField.value : undefined
        }))
        closeModal()
        const commentTips = { created: '，已新增审批意见', updated: '，审批意见已更新', deleted: '，审批意见已清空' }
        const tip = result && commentTips[result.action] ? commentTips[result.action] : ''
        toast(`历史任务已更新${tip}`, 'success')
        await reloadDetail()
    },
    'history-jump': async (el) => {
        const finished = state.detail.isFinished
        const ok = await askDialog({
            title: finished ? '重新激活并退回' : '退回到历史节点',
            message: `将流程退回任务 <strong>${esc(el.dataset.name)}</strong>：<br>
                · 当前所有任务、候选人会被删除<br>
                · 该节点之后的历史审批记录会被清理<br>
                · 流程变量会从历史记录恢复<br>
                ${finished ? '· 实例将重新激活为运行中' : ''}`,
            confirmText: '确认退回',
            danger: true
        })
        if (ok === null) return
        const data = await api.post(`/api/instances/${enc(state.detail.id)}/jump-to-task`, { taskId: el.dataset.id })
        toast('已退回到目标节点', 'success')
        await reloadDetail()
        if (state.view === 'instances') await loadInstances()
        if (state.view === 'overview') await loadOverview()
        if (data && data.warnings) data.warnings.forEach((warning) => toast(warning, 'info'))
    },

    /* ---- 任务 ---- */
    'open-task': (el) => openTaskModal(el.dataset.id, el.dataset.name, el.dataset.assignee).catch(handleError),
    'task-save-assignee': async (el) => {
        const assignee = $('taskAssigneeInput').value.trim()
        if (!assignee) {
            toast('请填写或选择用户', 'error')
            return
        }
        await withBusy(el, () => api.post(`/api/tasks/${enc(state.modalTask.id)}/set-assignee`, { assignee }))
        state.modalTask.assignee = assignee
        toast('处理人已更新', 'success')
        await refreshTaskModal()
        await reloadDetail()
        if (state.view === 'tasks') await loadTasks()
    },
    'task-clear-assignee': async (el) => {
        const ok = await askDialog({
            title: '清空处理人',
            message: '清空后任务回到待认领状态，候选人仍然保留。确定继续吗？',
            confirmText: '清空',
            danger: true
        })
        if (ok === null) return
        await withBusy(el, () => api.post(`/api/tasks/${enc(state.modalTask.id)}/set-assignee`, { assignee: '' }))
        state.modalTask.assignee = ''
        toast('处理人已清空', 'success')
        await refreshTaskModal()
        await reloadDetail()
        if (state.view === 'tasks') await loadTasks()
    },
    'candidate-add': async (el) => {
        const userId = $('candidateInput').value.trim()
        const type = $('candidateType').value
        if (!userId) {
            toast('请填写或选择用户', 'error')
            return
        }
        await withBusy(el, () => api.post(`/api/tasks/${enc(state.modalTask.id)}/identitylinks`, { userId, type }))
        toast('候选人已添加', 'success')
        await refreshTaskModal()
        await reloadDetail()
        if (state.view === 'tasks') await loadTasks()
    },
    'candidate-remove': async (el) => {
        const params = new URLSearchParams()
        if (el.dataset.user) params.set('userId', el.dataset.user)
        if (el.dataset.group) params.set('groupId', el.dataset.group)
        if (el.dataset.type) params.set('type', el.dataset.type)
        await api.delete(`/api/tasks/${enc(state.modalTask.id)}/identitylinks?${params.toString()}`)
        toast('已删除候选人', 'success')
        await refreshTaskModal()
        await reloadDetail()
        if (state.view === 'tasks') await loadTasks()
    },
    'task-toggle': async (el) => {
        const suspended = el.dataset.suspended === '1'
        await withBusy(el, () => api.post(`/api/tasks/${enc(el.dataset.id)}/${suspended ? 'activate' : 'suspend'}`))
        toast(suspended ? '任务已激活' : '任务已挂起', 'success')
        if (state.detailId) await reloadDetail()
        if (state.view === 'tasks') await loadTasks()
    },
    'task-page': (el) => {
        state.taskPage = Number(el.dataset.page) || 1
        loadTasks().catch(handleError)
    },

    /* ---- 流程定义 ---- */
    'xml-view': (el) => openXmlModal(el.dataset.id, false).catch(handleError),
    'xml-edit': (el) => openXmlModal(el.dataset.id, true).catch(handleError),
    'def-nodes': (el) => openDefinitionNodes(el.dataset.id).catch(handleError),
    'def-toggle': async (el) => {
        const suspended = el.dataset.suspended === '1'
        const ok = await askDialog({
            title: suspended ? '激活流程定义' : '挂起流程定义',
            message: suspended
                ? '激活后可以继续使用该定义发起新实例。'
                : '挂起后该定义不能再发起新实例，已运行的实例不受影响。',
            confirmText: suspended ? '激活' : '挂起',
            danger: !suspended
        })
        if (ok === null) return
        await api.post(`/api/definitions/${enc(el.dataset.id)}/${suspended ? 'activate' : 'suspend'}`)
        toast(suspended ? '流程定义已激活' : '流程定义已挂起', 'success')
        await loadDefinitionsView()
    },
    'job-state': (el) => {
        state.jobState = el.dataset.state || ''
        markActiveSegments()
        loadJobs().catch(handleError)
    },

    /* ---- 作业 ---- */
    'job-execute': async (el) => {
        await withBusy(el, () => api.post(`/api/jobs/${enc(el.dataset.id)}/execute`, { source: el.dataset.source }))
        toast('已将作业到期时间设为当前时间', 'success')
        await loadJobs()
        if (state.view === 'overview') await loadOverview()
    },
    'job-retry': async (el) => {
        const ok = await askDialog({
            title: '重置作业重试次数',
            message: `将作业 <code>${esc(el.dataset.id)}</code> 的重试次数重置为 3，以便作业执行器再次尝试。`,
            confirmText: '重置为 3 次'
        })
        if (ok === null) return
        await api.post(`/api/jobs/${enc(el.dataset.id)}/retries`, { source: el.dataset.source, retries: 3 })
        toast('重试次数已重置', 'success')
        await loadJobs()
    },
    'job-delete': async (el) => {
        const ok = await askDialog({
            title: '删除作业',
            message: `确定删除该作业吗？删除后不会再被调度。<br>作业ID：<code>${esc(el.dataset.id)}</code>`,
            confirmText: '删除',
            danger: true
        })
        if (ok === null) return
        await api.delete(`/api/jobs/${enc(el.dataset.id)}?source=${enc(el.dataset.source)}`)
        toast('作业已删除', 'success')
        await loadJobs()
        if (state.view === 'overview') await loadOverview()
    },
    'job-detail': async (el) => {
        const data = await api.get(`/api/jobs?size=200`)
        const job = (data.items || []).find((item) => item.id === el.dataset.id)
        if (!job) {
            toast('未找到该作业，可能已被执行或删除', 'info')
            return
        }
        const rows = [
            ['作业ID', `<code>${esc(job.id)}</code>`],
            ['类型', esc(job.sourceLabel)],
            ['处理器', esc(job.handlerType || job.type || '—')],
            ['流程实例', job.processInstanceId ? `<button type="button" class="link-btn mono" data-action="open-instance" data-id="${esc(job.processInstanceId)}">${esc(job.processInstanceId)}</button>` : '—'],
            ['执行实例', esc(job.executionId || '—')],
            ['重试次数', job.retries === null ? '—' : String(job.retries)],
            ['到期时间', esc(fmtTime(job.dueDate))],
            ['锁定者', esc(job.lockOwner || '—')]
        ]
        const body = `
            <div class="info-grid">
                ${rows.map(([label, value]) => `<div class="info-item"><span>${label}</span><div>${value}</div></div>`).join('')}
            </div>
            <h4 class="section-title">异常信息</h4>
            <pre class="code-block code-block-sm">${esc(job.exceptionMessage || '无异常信息')}</pre>
        `
        openModal(modalShell('作业详情', body, `
            <button type="button" class="btn btn-secondary" data-action="modal-close">关闭</button>
            ${['async', 'timer'].includes(job.source)
                ? `<button type="button" class="btn btn-primary" data-action="job-execute" data-id="${esc(job.id)}" data-source="${esc(job.source)}">立即执行</button>`
                : ''}
        `), 'md')
    },

    /* ---- 操作日志 ---- */
    'audit-clear': async () => {
        const ok = await askDialog({
            title: '清空操作日志',
            message: '将删除本机保存的所有操作记录，不影响数据库。确定清空吗？',
            confirmText: '清空',
            danger: true
        })
        if (ok === null) return
        await api.delete('/api/audit-logs')
        toast('操作日志已清空', 'success')
        await loadAudit()
    }
}

/* ============================ 事件绑定 ============================ */

document.addEventListener('click', (event) => {
    const trigger = event.target.closest('[data-action]')
    if (trigger) {
        const handler = actions[trigger.dataset.action]
        if (handler) {
            event.preventDefault()
            Promise.resolve(handler(trigger, event)).catch(handleError)
            return
        }
    }
    const nav = event.target.closest('[data-nav]')
    if (nav) {
        setView(nav.dataset.nav)
    }
})

document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
        if (!$('dialogRoot').hidden) {
            closeDialog(null)
            return
        }
        // 实例详情在层级上位于普通弹层之下，先关闭上层弹层，避免误关背后的详情
        if (!$('modalRoot').hidden) {
            Promise.resolve(actions['modal-close']()).catch(handleError)
            return
        }
        if (!$('drawerRoot').hidden) {
            Promise.resolve(actions['close-drawer']()).catch(handleError)
        }
    }
    if (event.key === 'Enter' && event.target.matches('input[type="search"]')) {
        applySearch(event.target.id)
    }
})

function applySearch(id) {
    if (id === 'instanceKeyword') {
        state.instanceKeyword = $('instanceKeyword').value.trim()
        state.instancePage = 1
        loadInstances().catch(handleError)
    } else if (id === 'taskKeyword') {
        state.taskKeyword = $('taskKeyword').value.trim()
        state.taskPage = 1
        loadTasks().catch(handleError)
    } else if (id === 'jobKeyword') {
        state.jobKeyword = $('jobKeyword').value.trim()
        loadJobs().catch(handleError)
    } else if (id === 'definitionKeyword') {
        state.definitionKeyword = $('definitionKeyword').value.trim()
        loadDefinitionsView().catch(handleError)
    }
}

let definitionSearchTimer = null

function bindStaticEvents() {
    $('connType').addEventListener('change', (event) => {
        const type = event.target.value
        $('connPort').value = defaultPort(type)
        $('schemaField').hidden = type === 'mysql'
        $('connDatabase').innerHTML = '<option value="">先测试连接获取数据库</option>'
        $('connDatabase').disabled = true
        $('connSchema').innerHTML = '<option value="">先选择数据库</option>'
        $('connSchema').disabled = true
        setConnMessage('')
    })

    $('connDatabase').addEventListener('change', async (event) => {
        const database = event.target.value
        if (!database) return
        if ($('connType').value === 'mysql') {
            setConnMessage(`已选择数据库 ${database}`, 'success')
            return
        }
        try {
            await loadSchemaList(database)
        } catch (error) {
            setConnMessage(error.message, 'error')
        }
    })

    $('connectionForm').addEventListener('submit', (event) => {
        event.preventDefault()
        connectDatabase($('connectButton')).catch(handleError)
    })

    $('instanceDefFilter').addEventListener('change', (event) => {
        state.instanceDefKey = event.target.value
        state.instancePage = 1
        loadInstances().catch(handleError)
    })

    $('taskDefFilter').addEventListener('change', (event) => {
        state.taskDefKey = event.target.value
        state.taskPage = 1
        loadTasks().catch(handleError)
    })

    $('taskAssigneeFilter').addEventListener('change', (event) => {
        state.taskAssignee = event.target.value
        state.taskPage = 1
        loadTasks().catch(handleError)
    })

    $('definitionKeyword').addEventListener('input', (event) => {
        clearTimeout(definitionSearchTimer)
        const keyword = event.target.value.trim()
        definitionSearchTimer = setTimeout(() => {
            state.definitionKeyword = keyword
            loadDefinitionsView().catch(handleError)
        }, 350)
    })

    // 搜索框输入时防抖，清空时立即刷新
    const searchInputs = [
        ['instanceKeyword', () => { state.instanceKeyword = $('instanceKeyword').value.trim(); state.instancePage = 1; return loadInstances() }],
        ['taskKeyword', () => { state.taskKeyword = $('taskKeyword').value.trim(); state.taskPage = 1; return loadTasks() }],
        ['jobKeyword', () => { state.jobKeyword = $('jobKeyword').value.trim(); return loadJobs() }]
    ]
    searchInputs.forEach(([id, reload]) => {
        const input = $(id)
        let timer = null
        input.addEventListener('input', () => {
            clearTimeout(timer)
            timer = setTimeout(() => { reload().catch(handleError) }, 400)
        })
        input.addEventListener('search', () => {
            clearTimeout(timer)
            reload().catch(handleError)
        })
    })
}

function markActiveSegments() {
    document.querySelectorAll('#instanceStatusTabs button').forEach((button) => {
        button.classList.toggle('is-active', button.dataset.status === state.instanceStatus)
    })
    document.querySelectorAll('#jobStateTabs button').forEach((button) => {
        button.classList.toggle('is-active', (button.dataset.state || '') === state.jobState)
    })
}

async function init() {
    bindStaticEvents()
    markActiveSegments()
    resetConnectionForm()
    await loadSavedConnections()
    await checkConnection()
}

init()
