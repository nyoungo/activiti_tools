// API 封装
const api = {
    async request(url, options = {}) {
        const response = await fetch(url, {
            headers: { 'Content-Type': 'application/json', ...options.headers },
            ...options
        })
        return response.json()
    },
    async get(url) { return this.request(url) },
    async post(url, data) {
        return this.request(url, { method: 'POST', body: JSON.stringify(data) })
    },
    async put(url, data) {
        return this.request(url, { method: 'PUT', body: JSON.stringify(data) })
    },
    async delete(url) {
        return this.request(url, { method: 'DELETE' })
    }
}

// 应用状态
const state = {
    connected: false,
    currentPage: 1,
    pageSize: 10,
    searchKeyword: '',
    currentInstanceId: null,
    instanceTab: 'running',
    currentDefinitionId: null,
    originalXml: null
}

// DOM 元素
const elements = {
    pages: document.querySelectorAll('.page'),
    statusDot: document.querySelector('.status-dot'),
    statusText: document.getElementById('statusText'),
    savedConnections: document.getElementById('savedConnections'),
    deleteConnection: document.getElementById('deleteConnection'),
    connName: document.getElementById('connName'),
    connType: document.getElementById('connType'),
    connHost: document.getElementById('connHost'),
    connPort: document.getElementById('connPort'),
    connDatabase: document.getElementById('connDatabase'),
    connSchema: document.getElementById('connSchema'),
    connUsername: document.getElementById('connUsername'),
    connPassword: document.getElementById('connPassword'),
    testConnection: document.getElementById('testConnection'),
    saveConnection: document.getElementById('saveConnection'),
    connect: document.getElementById('connect'),
    disconnect: document.getElementById('disconnect'),
    connectionMessage: document.getElementById('connectionMessage'),
    searchKeyword: document.getElementById('searchKeyword'),
    searchBtn: document.getElementById('searchBtn'),
    instancesTableBody: document.getElementById('instancesTableBody'),
    pagination: document.getElementById('pagination'),
    instanceModal: document.getElementById('instanceModal'),
    instanceModalBody: document.getElementById('instanceModalBody'),
    assigneeModal: document.getElementById('assigneeModal'),
    assigneeTaskId: document.getElementById('assigneeTaskId'),
    assigneeTaskName: document.getElementById('assigneeTaskName'),
    currentAssignee: document.getElementById('currentAssignee'),
    newAssignee: document.getElementById('newAssignee'),
    candidateUserId: document.getElementById('candidateUserId'),
    candidateType: document.getElementById('candidateType'),
    identityLinkList: document.getElementById('identityLinkList'),
    xmlModal: document.getElementById('xmlModal'),
    xmlContent: document.getElementById('xmlContent'),
    xmlActions: document.getElementById('xmlActions')
}

// 初始化
async function init() {
    bindEvents()
    await checkConnectionStatus()
    await loadConnections()
}

// 绑定事件
function bindEvents() {
    // 数据库类型切换
    elements.connType.addEventListener('change', () => {
        const type = elements.connType.value
        if (type === 'mysql') {
            elements.connPort.value = '3306'
        } else if (type === 'postgres') {
            elements.connPort.value = '5432'
        } else if (type === 'hgdatabase') {
            elements.connPort.value = '5866'
        }
    })

    // 已保存的配置
    elements.savedConnections.addEventListener('change', () => {
        const id = elements.savedConnections.value
        elements.deleteConnection.style.display = id ? 'inline-block' : 'none'
        if (id) loadConnectionById(parseInt(id))
    })

    // 删除配置
    elements.deleteConnection.addEventListener('click', deleteCurrentConnection)

    // 测试连接
    elements.testConnection.addEventListener('click', testConnection)

    // 保存配置
    elements.saveConnection.addEventListener('click', saveConnection)

    // 连接
    elements.connect.addEventListener('click', connectToDb)

    // 断开
    elements.disconnect.addEventListener('click', disconnectFromDb)

    // 搜索
    elements.searchBtn.addEventListener('click', () => {
        state.searchKeyword = elements.searchKeyword.value
        state.currentPage = 1
        loadInstances()
    })
    elements.searchKeyword.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') elements.searchBtn.click()
    })

    // 模态框关闭
    document.querySelectorAll('.modal-close').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = btn.closest('.modal')
            if (modal) modal.classList.remove('show')
        })
    })
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', (e) => {
            if (e.target === modal) modal.classList.remove('show')
        })
    })

    // 标签页切换
    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'))
            btn.classList.add('active')
            state.instanceTab = btn.dataset.tab
            state.currentPage = 1
            loadInstances()
        })
    })
}

// 切换页面
function switchPage(page) {
    elements.pages.forEach(p => {
        p.classList.toggle('active', p.id === `page-${page}`)
    })

    if (page === 'instances' && state.connected) {
        loadInstances()
    }
}

// 检查连接状态
async function checkConnectionStatus() {
    const result = await api.get('/api/connection-status')
    state.connected = result.connected
    updateConnectionStatus()

    if (state.connected) {
        switchPage('instances')
    }
}

// 更新连接状态显示
function updateConnectionStatus() {
    elements.statusDot.classList.toggle('connected', state.connected)
    elements.statusText.textContent = state.connected ? '已连接' : '未连接'
    elements.connect.style.display = state.connected ? 'none' : 'inline-block'
    elements.disconnect.style.display = state.connected ? 'inline-block' : 'none'
}

// 加载保存的连接配置
async function loadConnections() {
    const connections = await api.get('/api/connections')
    elements.savedConnections.innerHTML = '<option value="">-- 选择配置 --</option>'
    connections.forEach(conn => {
        const option = document.createElement('option')
        option.value = conn.id
        option.textContent = conn.name
        option.dataset.config = JSON.stringify(conn)
        elements.savedConnections.appendChild(option)
    })
}

// 加载指定配置
function loadConnectionById(id) {
    const option = elements.savedConnections.querySelector(`option[value="${id}"]`)
    if (option) {
        const config = JSON.parse(option.dataset.config)
        elements.connName.value = config.name
        elements.connType.value = config.db_type
        elements.connHost.value = config.host
        elements.connPort.value = config.port
        elements.connDatabase.value = config.database
        elements.connSchema.value = config.schema || ''
        elements.connUsername.value = config.username
        elements.connPassword.value = ''
    }
}

// 获取当前表单配置
function getConnectionConfig() {
    return {
        name: elements.connName.value,
        dbType: elements.connType.value,
        host: elements.connHost.value,
        port: parseInt(elements.connPort.value) || 3306,
        database: elements.connDatabase.value,
        schema: elements.connSchema.value,
        username: elements.connUsername.value,
        password: elements.connPassword.value
    }
}

// 显示消息
function showMessage(element, text, type = 'success') {
    element.textContent = text
    element.className = `message ${type}`
    setTimeout(() => {
        element.className = 'message'
    }, 3000)
}

// 测试连接
async function testConnection() {
    const config = getConnectionConfig()
    const result = await api.post('/api/test-connection', config)
    showMessage(elements.connectionMessage, result.message, result.success ? 'success' : 'error')
}

// 保存配置
async function saveConnection() {
    const config = getConnectionConfig()
    if (!config.name) {
        showMessage(elements.connectionMessage, '请输入连接名称', 'error')
        return
    }
    const result = await api.post('/api/save-connection', config)
    if (result.success) {
        showMessage(elements.connectionMessage, '配置保存成功', 'success')
        await loadConnections()
    }
}

// 删除配置
async function deleteCurrentConnection() {
    const id = elements.savedConnections.value
    if (!id) return
    if (!confirm('确定删除此配置吗？')) return

    await api.delete(`/api/connections/${id}`)
    showMessage(elements.connectionMessage, '配置已删除', 'success')
    await loadConnections()
    elements.deleteConnection.style.display = 'none'
}

// 连接数据库
async function connectToDb() {
    const config = getConnectionConfig()
    const result = await api.post('/api/connect', config)
    if (result.success) {
        state.connected = true
        updateConnectionStatus()
        showMessage(elements.connectionMessage, '连接成功', 'success')
        switchPage('instances')
    } else {
        showMessage(elements.connectionMessage, result.message, 'error')
    }
}

// 断开连接
async function disconnectFromDb() {
    await api.post('/api/disconnect')
    state.connected = false
    updateConnectionStatus()
    elements.instancesTableBody.innerHTML = '<tr><td colspan="7" class="text-center">请连接数据库</td></tr>'
    elements.pagination.innerHTML = ''
    switchPage('connection')
}

// 加载流程实例
async function loadInstances() {
    if (!state.connected) return

    elements.instancesTableBody.innerHTML = '<tr><td colspan="7" class="text-center"><span class="loading">加载中...</span></td></tr>'

    const result = await api.get(`/api/instances?page=${state.currentPage}&size=${state.pageSize}&keyword=${encodeURIComponent(state.searchKeyword)}&status=${state.instanceTab}`)

    if (!result || (!result.instances && !result.error)) {
        elements.instancesTableBody.innerHTML = '<tr><td colspan="7" class="text-center">加载数据失败</td></tr>'
        elements.pagination.innerHTML = ''
        return
    }

    const instances = result.instances || []
    const total = result.total || 0

    if (instances.length > 0) {
        elements.instancesTableBody.innerHTML = instances.map(inst => `
            <tr>
                <td><code>${inst.id}</code></td>
                <td>${inst.procDefName || '-'}</td>
                <td>${inst.businessKey || '-'}</td>
                <td>${inst.startUserRealname || inst.startUserName || inst.startUserId || '-'}</td>
                <td>${new Date(inst.startTime).toLocaleString()}</td>
                <td><span class="status-tag ${inst.isFinished ? 'status-finished' : 'status-running'}">${inst.isFinished ? '已结束' : '运行中'}</span></td>
                <td>
                    <button class="btn btn-small btn-primary" onclick="showInstanceDetail('${inst.id}', ${inst.isFinished})">详情</button>
                    <button class="btn btn-small btn-danger" onclick="deleteInstance('${inst.id}')">删除</button>
                </td>
            </tr>
        `).join('')
        renderPagination(total)
    } else {
        elements.instancesTableBody.innerHTML = '<tr><td colspan="7" class="text-center">暂无数据</td></tr>'
        renderPagination(total)
    }
}

// 渲染分页
function renderPagination(total) {
    const totalPages = Math.max(1, Math.ceil(total / state.pageSize))
    let html = `<div class="pagination-info">共 ${total} 条记录，第 ${state.currentPage}/${totalPages} 页</div>`

    if (totalPages > 1) {
        html += `<button onclick="goToPage(${state.currentPage - 1})" ${state.currentPage <= 1 ? 'disabled' : ''}>上一页</button>`

        for (let i = 1; i <= totalPages; i++) {
            if (i === 1 || i === totalPages || (i >= state.currentPage - 2 && i <= state.currentPage + 2)) {
                html += `<button class="${i === state.currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`
            } else if (i === state.currentPage - 3 || i === state.currentPage + 3) {
                html += '<span>...</span>'
            }
        }

        html += `<button onclick="goToPage(${state.currentPage + 1})" ${state.currentPage >= totalPages ? 'disabled' : ''}>下一页</button>`
    }
    
    elements.pagination.innerHTML = html
}

// 跳转页码
async function goToPage(page) {
    if (page < 1) return
    state.currentPage = page
    await loadInstances()
}

// 显示流程实例详情
async function showInstanceDetail(instanceId, isFinished = false) {
    state.currentInstanceId = instanceId

    const [instance, variables, historyTasks] = await Promise.all([
        api.get(`/api/instances/${instanceId}`),
        api.get(`/api/instances/${instanceId}/variables`),
        api.get(`/api/instances/${instanceId}/history-tasks`)
    ])

    const finishedClass = instance.isFinished ? 'status-finished' : 'status-running'
    const statusText = instance.isFinished ? '已结束' : '运行中'

    elements.instanceModalBody.innerHTML = `
        <div class="detail-section">
            <h4>基本信息</h4>
            <div class="info-grid">
                <div class="info-item"><label>实例ID</label><span><code>${instance.id}</code></span></div>
                <div class="info-item"><label>流程名称</label><span>${instance.procDefName || '-'}</span></div>
                <div class="info-item"><label>业务Key</label><span>${instance.businessKey || '-'}</span></div>
                <div class="info-item"><label>状态</label><span><span class="status-tag ${finishedClass}">${statusText}</span></span></div>
                <div class="info-item"><label>开始时间</label><span>${new Date(instance.startTime).toLocaleString()}</span></div>
                <div class="info-item"><label>发起人</label><span>${instance.startUserRealname || instance.startUserName || instance.startUserId || '-'}</span></div>
            </div>
            <div style="margin-top: 16px;">
                <button class="btn btn-secondary btn-small" onclick="viewDefinitionXml('${instance.procDefId}')">查看流程图</button>
                ${!isFinished ? '<button class="btn btn-secondary btn-small" onclick="editDefinitionXml(\'' + instance.procDefId + '\')">修改流程图</button>' : ''}
            </div>
        </div>

        <div class="detail-section">
            <h4>当前任务</h4>
            ${(instance.currentTasks || []).length > 0 ? `
                <table class="data-table">
                    <thead><tr><th>任务ID</th><th>任务名称</th><th>处理人</th><th>创建时间</th><th>操作</th></tr></thead>
                    <tbody>
                        ${instance.currentTasks.map(t => {
                            let assigneeDisplay = '-'
                            if (t.assignee) {
                                assigneeDisplay = t.assigneeRealname || t.assigneeName || t.assignee
                            } else if (t.candidates && t.candidates.length > 0) {
                                assigneeDisplay = t.candidates.map(c => c.realname || c.username || c.userId).join(', ')
                            }
                            return `
                            <tr>
                                <td><code>${t.id}</code></td>
                                <td>${t.name}</td>
                                <td>${assigneeDisplay}</td>
                                <td>${new Date(t.createTime).toLocaleString()}</td>
                                <td>
                                    <button class="btn btn-small btn-primary" onclick="openAssigneeModal('${t.id}', '${t.name}', '${t.assignee || ''}')">设置审批人</button>
                                </td>
                            </tr>
                        `}).join('')}
                    </tbody>
                </table>
            ` : '<p class="text-center">暂无当前任务</p>'}
        </div>

        <div class="detail-section">
            <h4>流程变量</h4>
            <table class="variable-table">
                <thead>
                    <tr><th>变量名</th><th>类型</th><th>值</th><th>操作</th></tr>
                </thead>
                <tbody id="variableTableBody">
                    ${variables.map(v => {
                        const isByteArray = v.value === '[byteArray]' || (v.type && (v.type.toLowerCase().includes('byte') || v.type.toLowerCase() === 'serializable'))
                        return `
                        <tr data-name="${v.name}" ${isByteArray ? 'class="variable-disabled"' : ''}>
                            <td><input type="text" value="${v.name}" readonly></td>
                            <td>
                                <select onchange="updateVariableType('${v.name}', this.value)" ${isByteArray ? 'disabled' : ''}>
                                    <option value="string" ${v.type === 'string' ? 'selected' : ''}>String</option>
                                    <option value="long" ${v.type === 'long' ? 'selected' : ''}>Long</option>
                                    <option value="double" ${v.type === 'double' ? 'selected' : ''}>Double</option>
                                    <option value="boolean" ${v.type === 'boolean' ? 'selected' : ''}>Boolean</option>
                                </select>
                            </td>
                            <td>
                                <input type="text" value="${v.value || ''}" id="var-${v.name}" ${isByteArray ? 'readonly' : ''}>
                            </td>
                            <td>
                                <button class="btn btn-small btn-primary" onclick="saveVariable('${v.name}')" ${isByteArray ? 'disabled' : ''}>保存</button>
                                <button class="btn btn-small btn-danger" onclick="deleteVariable('${v.name}')">删除</button>
                            </td>
                        </tr>
                    `}).join('')}
                </tbody>
            </table>
            <div class="add-variable">
                <input type="text" id="newVarName" placeholder="变量名">
                <select id="newVarType">
                    <option value="string">String</option>
                    <option value="long">Long</option>
                    <option value="double">Double</option>
                    <option value="boolean">Boolean</option>
                </select>
                <input type="text" id="newVarValue" placeholder="变量值">
                <button class="btn btn-primary" onclick="addVariable()">添加</button>
            </div>
        </div>

        <div class="detail-section">
            <h4>历史任务</h4>
            ${historyTasks.length > 0 ? `
                <table class="data-table">
                    <thead><tr><th>任务ID</th><th>任务名称</th><th>处理人</th><th>开始时间</th><th>结束时间</th><th>操作</th></tr></thead>
                    <tbody>
                        ${historyTasks.map(t => `
                            <tr>
                                <td><code>${t.id}</code></td>
                                <td>${t.name}</td>
                                <td>${t.assigneeRealname || t.assigneeName || t.assignee || '-'}</td>
                                <td>${t.startTime ? new Date(t.startTime).toLocaleString() : '-'}</td>
                                <td>${t.endTime ? new Date(t.endTime).toLocaleString() : '-'}</td>
                                <td>
                                    <button class="btn btn-small btn-primary" onclick="openEditHistoryTaskModal('${t.id}', '${t.name}', '${t.assignee || ''}', '${t.endTime || ''}')">编辑</button>
                                    <button class="btn btn-small btn-danger" onclick="returnToTask('${t.id}', '${t.name || t.id}', ${isFinished})">退回此处</button>
                                </td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : '<p class="text-center">暂无历史任务</p>'}
        </div>
    `

    elements.instanceModal.classList.add('show')
}

// 关闭实例详情模态框
function closeInstanceModal() {
    elements.instanceModal.classList.remove('show')
}

// 添加变量
async function addVariable() {
    const name = document.getElementById('newVarName').value.trim()
    const type = document.getElementById('newVarType').value
    const value = document.getElementById('newVarValue').value

    if (!name) {
        alert('请输入变量名')
        return
    }

    await api.post(`/api/instances/${state.currentInstanceId}/variables`, { name, type, value })

    document.getElementById('newVarName').value = ''
    document.getElementById('newVarValue').value = ''

    showInstanceDetail(state.currentInstanceId)
}

// 更新变量类型
function updateVariableType(name, type) {
    // 这里只是更新本地UI，实际保存时再提交
}

// 保存变量
async function saveVariable(name) {
    const type = document.querySelector(`#variableTableBody tr[data-name="${name}"] select`).value
    const value = document.getElementById(`var-${name}`).value

    await api.post(`/api/instances/${state.currentInstanceId}/variables`, { name, type, value })
    alert('变量保存成功')
}

// 删除变量
async function deleteVariable(name) {
    if (!confirm('确定删除此变量吗？')) return
    await api.delete(`/api/instances/${state.currentInstanceId}/variables/${name}`)
    showInstanceDetail(state.currentInstanceId)
}

// 删除流程实例
async function deleteInstance(instanceId) {
    if (!confirm('⚠️ 警告：删除流程实例将删除所有相关数据，包括运行时数据和历史记录！\n\n确定要删除此流程实例吗？')) {
        return
    }

    const result = await api.delete(`/api/instances/${instanceId}`)

    if (result.success) {
        alert('删除成功')
        loadInstances()
    } else {
        alert('删除失败: ' + result.error)
    }
}

// 直接退回到任务
async function returnToTask(taskId, taskName, isFinished) {
    const actionText = isFinished ? '重新激活并退回到' : '退回到'
    const confirmMsg = isFinished 
        ? `⚠️ 已结束流程退回警告：\n\n此操作将重新激活已结束的流程实例！\n\n确定要将流程「${actionText}」任务「${taskName}」吗？`
        : `确定要将流程${actionText}任务「${taskName}」吗？这将重置流程状态。`
    
    if (!confirm(confirmMsg)) return

    const apiUrl = isFinished 
        ? `/api/instances/${state.currentInstanceId}/jump-to-finished-task`
        : `/api/instances/${state.currentInstanceId}/jump-to-task`

    const result = await api.post(apiUrl, { taskId: taskId })

    if (result.success) {
        alert('退回成功')
        closeInstanceModal()
        loadInstances()
    } else {
        alert('退回失败: ' + result.error)
    }
}

// 审批人设置相关
let currentTaskId = null

async function openAssigneeModal(taskId, taskName, currentAssignee) {
    currentTaskId = taskId
    elements.assigneeTaskId.value = taskId
    elements.assigneeTaskName.value = taskName
    elements.currentAssignee.value = currentAssignee || '无'
    elements.newAssignee.value = ''
    elements.candidateUserId.value = ''

    await loadIdentityLinks(taskId)
    elements.assigneeModal.classList.add('show')
}

async function loadIdentityLinks(taskId) {
    const identitylinks = await api.get(`/api/tasks/${taskId}/identitylinks`)

    if (identitylinks && identitylinks.length > 0) {
        elements.identityLinkList.innerHTML = identitylinks.map(link => {
            const displayName = link.realname || link.username || link.userId
            const userInfo = link.username ? `${link.userId} (${displayName})` : link.userId
            return `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px; border-bottom: 1px solid #eee;">
                <span>${userInfo} - ${link.type === 'candidate' ? '候选人' : '审批人'}</span>
                <button class="btn btn-small btn-danger" onclick="removeIdentityLink('${link.userId}', '${link.type}')">删除</button>
            </div>
        `}).join('')
    } else {
        elements.identityLinkList.innerHTML = '<p style="color: #999; text-align: center;">暂无候选人/审批人</p>'
    }
}

async function saveAssignee() {
    const newAssignee = elements.newAssignee.value.trim()

    if (!newAssignee) {
        alert('请输入审批人ID')
        return
    }

    const result = await api.post(`/api/tasks/${currentTaskId}/set-assignee`, { assignee: newAssignee })

    if (result.success) {
        alert('审批人设置成功')
        elements.currentAssignee.value = newAssignee
        elements.newAssignee.value = ''
        await loadIdentityLinks(currentTaskId)
        showInstanceDetail(state.currentInstanceId)
    } else {
        alert('设置失败: ' + result.error)
    }
}

async function addCandidate() {
    const userId = elements.candidateUserId.value.trim()
    const type = elements.candidateType.value

    if (!userId) {
        alert('请输入用户ID')
        return
    }

    const result = await api.post(`/api/tasks/${currentTaskId}/add-identitylink`, { userId, type })

    if (result.success) {
        alert('添加成功')
        elements.candidateUserId.value = ''
        await loadIdentityLinks(currentTaskId)
    } else {
        alert('添加失败: ' + result.error)
    }
}

async function removeIdentityLink(userId, type) {
    if (!confirm(`确定删除用户 ${userId} 的身份链接吗？`)) return

    const result = await api.delete(`/api/tasks/${currentTaskId}/identitylink?userId=${userId}&type=${type}`)

    if (result.success) {
        alert('删除成功')
        await loadIdentityLinks(currentTaskId)
    } else {
        alert('删除失败: ' + result.error)
    }
}

async function refreshTaskInfo() {
    if (!currentTaskId) return

    const instance = await api.get(`/api/instances/${state.currentInstanceId}`)
    const task = instance.currentTasks.find(t => t.id === currentTaskId)

    if (task) {
        elements.currentAssignee.value = task.assignee || '无'
    }

    await loadIdentityLinks(currentTaskId)
}

// 查看流程定义XML
async function viewDefinitionXml(defId) {
    const result = await api.get(`/api/definitions/${defId}/xml`)
    elements.xmlContent.value = result.xml || ''
    elements.xmlContent.readOnly = true
    elements.xmlActions.style.display = 'none'
    state.currentDefinitionId = defId
    state.originalXml = result.xml
    document.getElementById('affectedInstancesInfo').style.display = 'none'
    elements.xmlModal.classList.add('show')
}

// 编辑流程定义XML
async function editDefinitionXml(defId) {
    const result = await api.get(`/api/definitions/${defId}/xml`)
    elements.xmlContent.value = result.xml || ''
    elements.xmlContent.readOnly = false
    elements.xmlActions.style.display = 'block'
    state.currentDefinitionId = defId
    state.originalXml = result.xml

    const affectedInfo = document.getElementById('affectedInstancesInfo')
    try {
        const affected = await api.get(`/api/definitions/${defId}/affected-instances`)
        if (affected.total > 0) {
            const earliest = affected.earliestStart ? new Date(affected.earliestStart).toLocaleString() : '-'
            const latest = affected.latestStart ? new Date(affected.latestStart).toLocaleString() : '-'
            affectedInfo.innerHTML = `<div style="padding: 12px; background-color: #fff3cd; border: 1px solid #ffc107; border-radius: 6px; color: #856404;"><strong>⚠️ 警告：此操作可能影响 ${affected.total} 个历史实例</strong><br><small>实例时间段：${earliest} ~ ${latest}</small></div>`
            affectedInfo.style.display = 'block'
        } else {
            affectedInfo.innerHTML = `<div style="padding: 12px; background-color: #d1ecf1; border: 1px solid #17a2b8; border-radius: 6px; color: #0c5460;"><strong>ℹ️ 暂无关联的历史实例，可以安全修改</strong></div>`
            affectedInfo.style.display = 'block'
        }
    } catch (error) {
        affectedInfo.style.display = 'none'
    }

    elements.xmlModal.classList.add('show')
}

// 保存XML
async function saveXml() {
    const xml = elements.xmlContent.value
    if (!xml.trim()) {
        alert('XML内容不能为空')
        return
    }

    const affected = await api.get(`/api/definitions/${state.currentDefinitionId}/affected-instances`)
    let confirmMsg = '确定要保存修改吗？'

    if (affected.total > 0) {
        const earliest = affected.earliestStart ? new Date(affected.earliestStart).toLocaleString() : '-'
        const latest = affected.latestStart ? new Date(affected.latestStart).toLocaleString() : '-'
        confirmMsg = `⚠️ 警告：此操作可能影响 ${affected.total} 个历史实例\n\n实例时间段：${earliest} ~ ${latest}\n\n确定要继续保存吗？`
    }

    if (!confirm(confirmMsg)) {
        return
    }

    const result = await api.put(`/api/definitions/${state.currentDefinitionId}/xml`, { xml })

    if (result.success) {
        alert('保存成功')
        state.originalXml = xml
    } else {
        alert('保存失败: ' + result.error)
    }
}

// 重置XML
function resetXml() {
    elements.xmlContent.value = state.originalXml
}

// 关闭XML模态框
function closeXmlModal() {
    elements.xmlModal.classList.remove('show')
}

// 用户缓存 - 本次连接一直缓存
let cachedUsers = []

async function getUsers(keyword = '') {
    // 优先加载完整用户列表
    if (cachedUsers.length === 0) {
        const users = await api.get(`/api/users`)
        cachedUsers = users
    }
    
    // 缓存中有数据，直接过滤返回
    if (keyword) {
        return cachedUsers.filter(u => 
            u.username.toLowerCase().includes(keyword.toLowerCase()) ||
            u.realname.toLowerCase().includes(keyword.toLowerCase())
        )
    }
    return cachedUsers
}

async function searchUsers(input, callback) {
    const keyword = input.value
    const users = await getUsers(keyword)
    
    const dropdown = input.nextElementSibling
    if (dropdown && dropdown.classList.contains('user-dropdown')) {
        if (users.length > 0) {
            dropdown.innerHTML = users.map(u => `
                <div class="dropdown-item" onclick="selectUser('${u.id}', '${u.username}', '${u.realname}', '${input.id}')">
                    ${u.realname || u.username} (${u.username})
                </div>
            `).join('')
            dropdown.style.display = 'block'
        } else {
            dropdown.innerHTML = '<div class="dropdown-item">没有找到匹配的用户</div>'
            dropdown.style.display = 'block'
        }
    }
    
    if (callback) callback(users)
}

function selectUser(userId, username, realname, inputId) {
    const input = document.getElementById(inputId)
    input.value = userId
    input.setAttribute('data-username', username)
    input.setAttribute('data-realname', realname)
    
    const dropdown = input.nextElementSibling
    if (dropdown && dropdown.classList.contains('user-dropdown')) {
        dropdown.style.display = 'none'
    }
}

function clearUserSelection(inputId) {
    const input = document.getElementById(inputId)
    input.value = ''
    input.removeAttribute('data-username')
    input.removeAttribute('data-realname')
    
    const dropdown = input.nextElementSibling
    if (dropdown && dropdown.classList.contains('user-dropdown')) {
        dropdown.style.display = 'none'
    }
}

function closeUserDropdowns() {
    document.querySelectorAll('.user-dropdown').forEach(dropdown => {
        dropdown.style.display = 'none'
    })
}

document.addEventListener('click', (e) => {
    if (!e.target.closest('.user-selector')) {
        closeUserDropdowns()
    }
})

// 编辑历史任务模态框
let currentHistoryTaskId = null

function openEditHistoryTaskModal(taskId, taskName, assignee, endTime) {
    currentHistoryTaskId = taskId
    
    document.getElementById('editHistoryTaskName').value = taskName
    document.getElementById('editHistoryAssignee').value = assignee
    document.getElementById('editHistoryAssignee').setAttribute('data-realname', '')
    
    if (endTime) {
        const date = new Date(endTime)
        document.getElementById('editHistoryEndTime').value = date.toISOString().slice(0, 16)
    } else {
        document.getElementById('editHistoryEndTime').value = ''
    }
    
    document.getElementById('editHistoryTaskModal').classList.add('show')
}

async function saveHistoryTaskEdit() {
    if (!currentHistoryTaskId) return
    
    const assignee = document.getElementById('editHistoryAssignee').value
    const endTime = document.getElementById('editHistoryEndTime').value
    
    if (!assignee) {
        alert('请选择审批人')
        return
    }
    
    const result = await api.put(`/api/history-tasks/${currentHistoryTaskId}/assignee`, {
        assignee,
        endTime: endTime ? new Date(endTime).toISOString() : null
    })
    
    if (result.success) {
        alert('修改成功')
        document.getElementById('editHistoryTaskModal').classList.remove('show')
        showInstanceDetail(state.currentInstanceId)
    } else {
        alert('修改失败: ' + result.error)
    }
}

function closeEditHistoryTaskModal() {
    document.getElementById('editHistoryTaskModal').classList.remove('show')
    currentHistoryTaskId = null
}

// 刷新用户缓存
function refreshUserCache() {
    cachedUsers = []
    cacheTimestamp = 0
}

// 启动应用
init()
