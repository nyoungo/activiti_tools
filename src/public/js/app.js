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
    navItems: document.querySelectorAll('.nav-item'),
    pages: document.querySelectorAll('.page'),
    connectionStatus: document.getElementById('connectionStatus'),
    statusDot: document.querySelector('.status-dot'),
    statusText: document.getElementById('statusText'),
    savedConnections: document.getElementById('savedConnections'),
    deleteConnection: document.getElementById('deleteConnection'),
    connName: document.getElementById('connName'),
    connType: document.getElementById('connType'),
    connHost: document.getElementById('connHost'),
    connPort: document.getElementById('connPort'),
    connDatabase: document.getElementById('connDatabase'),
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
    definitionsTableBody: document.getElementById('definitionsTableBody'),
    pagination: document.getElementById('pagination'),
    instanceModal: document.getElementById('instanceModal'),
    instanceModalBody: document.getElementById('instanceModalBody'),
    xmlModal: document.getElementById('xmlModal'),
    xmlContent: document.getElementById('xmlContent'),
    xmlActions: document.getElementById('xmlActions'),
    assigneeModal: document.getElementById('assigneeModal'),
    assigneeTaskId: document.getElementById('assigneeTaskId'),
    assigneeTaskName: document.getElementById('assigneeTaskName'),
    currentAssignee: document.getElementById('currentAssignee'),
    newAssignee: document.getElementById('newAssignee'),
    candidateUserId: document.getElementById('candidateUserId'),
    candidateType: document.getElementById('candidateType'),
    identityLinkList: document.getElementById('identityLinkList'),
    returnTaskModal: document.getElementById('returnTaskModal'),
    returnCurrentTask: document.getElementById('returnCurrentTask'),
    returnTargetTask: document.getElementById('returnTargetTask'),
    returnReason: document.getElementById('returnReason')
}

// 初始化
async function init() {
    bindEvents()
    await checkConnectionStatus()
    await loadConnections()
}

// 绑定事件
function bindEvents() {
    // 导航
    elements.navItems.forEach(item => {
        item.addEventListener('click', () => {
            const page = item.dataset.page
            switchPage(page)
        })
    })

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
    elements.navItems.forEach(item => {
        item.classList.toggle('active', item.dataset.page === page)
    })
    elements.pages.forEach(p => {
        p.classList.toggle('active', p.id === `page-${page}`)
    })

    if (page === 'instances' && state.connected) {
        loadInstances()
    } else if (page === 'definitions' && state.connected) {
        loadDefinitions()
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
    elements.definitionsTableBody.innerHTML = '<tr><td colspan="5" class="text-center">暂无数据</td></tr>'
    switchPage('connection')
}

// 加载流程实例
async function loadInstances() {
    if (!state.connected) return

    const result = await api.get(`/api/instances?page=${state.currentPage}&size=${state.pageSize}&keyword=${encodeURIComponent(state.searchKeyword)}&status=${state.instanceTab}`)

    if (!result || (!result.instances && !result.error)) {
        elements.instancesTableBody.innerHTML = '<tr><td colspan="7" class="text-center">加载数据失败</td></tr>'
        elements.pagination.innerHTML = ''
        return
    }

    const instances = result.instances || []

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
                </td>
            </tr>
        `).join('')
        renderPagination(result.total || 0)
    } else {
        elements.instancesTableBody.innerHTML = '<tr><td colspan="7" class="text-center">暂无数据</td></tr>'
        elements.pagination.innerHTML = ''
    }
}

// 渲染分页
function renderPagination(total) {
    const totalPages = Math.ceil(total / state.pageSize)
    if (totalPages <= 1) {
        elements.pagination.innerHTML = ''
        return
    }

    let html = `<button onclick="goToPage(${state.currentPage - 1})" ${state.currentPage <= 1 ? 'disabled' : ''}>上一页</button>`

    for (let i = 1; i <= totalPages; i++) {
        if (i === 1 || i === totalPages || (i >= state.currentPage - 2 && i <= state.currentPage + 2)) {
            html += `<button class="${i === state.currentPage ? 'active' : ''}" onclick="goToPage(${i})">${i}</button>`
        } else if (i === state.currentPage - 3 || i === state.currentPage + 3) {
            html += '<span>...</span>'
        }
    }

    html += `<button onclick="goToPage(${state.currentPage + 1})" ${state.currentPage >= totalPages ? 'disabled' : ''}>下一页</button>`
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
                        ${instance.currentTasks.map(t => `
                            <tr>
                                <td><code>${t.id}</code></td>
                                <td>${t.name}</td>
                                <td>${t.assigneeRealname || t.assigneeName || t.assignee || '-'}</td>
                                <td>${new Date(t.createTime).toLocaleString()}</td>
                                <td>
                                    <button class="btn btn-small btn-primary" onclick="openAssigneeModal('${t.id}', '${t.name}', '${t.assignee || ''}')">设置审批人</button>
                                </td>
                            </tr>
                        `).join('')}
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
                    ${variables.map(v => `
                        <tr data-name="${v.name}">
                            <td><input type="text" value="${v.name}" readonly></td>
                            <td>
                                <select onchange="updateVariableType('${v.name}', this.value)">
                                    <option value="string" ${v.type === 'string' ? 'selected' : ''}>String</option>
                                    <option value="long" ${v.type === 'long' ? 'selected' : ''}>Long</option>
                                    <option value="double" ${v.type === 'double' ? 'selected' : ''}>Double</option>
                                </select>
                            </td>
                            <td><input type="text" value="${v.value || ''}" id="var-${v.name}"></td>
                            <td>
                                <button class="btn btn-small btn-primary" onclick="saveVariable('${v.name}')">保存</button>
                                <button class="btn btn-small btn-danger" onclick="deleteVariable('${v.name}')">删除</button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
            <div class="add-variable">
                <input type="text" id="newVarName" placeholder="变量名">
                <select id="newVarType">
                    <option value="string">String</option>
                    <option value="long">Long</option>
                    <option value="double">Double</option>
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
                                    ${!isFinished ? '<button class="btn btn-small btn-danger" onclick="openReturnTaskModal(\'' + t.id + '\', \'' + (t.name || t.id) + '\')">退回此处</button>' : ''}
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
            affectedInfo.innerHTML = `
                <div class="warning-box">
                    <strong>⚠️ 警告：此操作可能影响 ${affected.total} 个历史实例</strong><br>
                    <small>实例时间段：${earliest} ~ ${latest}</small>
                </div>
            `
            affectedInfo.style.display = 'block'
        } else {
            affectedInfo.innerHTML = `
                <div class="info-box">
                    <strong>ℹ️ 暂无关联的历史实例，可以安全修改</strong>
                </div>
            `
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

// 加载流程定义
async function loadDefinitions() {
    if (!state.connected) {
        elements.definitionsTableBody.innerHTML = '<tr><td colspan="5" class="text-center">请先连接数据库</td></tr>'
        return
    }

    try {
        const definitions = await api.get('/api/definitions')

        if (!definitions || (Array.isArray(definitions) && definitions.length === 0)) {
            elements.definitionsTableBody.innerHTML = '<tr><td colspan="5" class="text-center">暂无数据</td></tr>'
            return
        }

        if (Array.isArray(definitions) && definitions.length > 0) {
            elements.definitionsTableBody.innerHTML = definitions.map(def => `
                <tr>
                    <td><code>${def.id}</code></td>
                    <td>${def.key}</td>
                    <td>${def.name || '-'}</td>
                    <td>${def.version}</td>
                    <td>
                        <button class="btn btn-small btn-primary" onclick="viewDefinitionXml('${def.id}')">查看</button>
                        <button class="btn btn-small btn-secondary" onclick="editDefinitionXml('${def.id}')">修改</button>
                    </td>
                </tr>
            `).join('')
        }
    } catch (error) {
        console.error('加载流程定义失败:', error)
        elements.definitionsTableBody.innerHTML = '<tr><td colspan="5" class="text-center">加载失败</td></tr>'
    }
}

// 退回任务模态框
let currentReturnTaskId = null

async function openReturnTaskModal(taskId, taskName) {
    currentReturnTaskId = taskId
    elements.returnCurrentTask.value = `${taskId} - ${taskName}`

    // 加载历史任务列表
    const historyTasks = await api.get(`/api/instances/${state.currentInstanceId}/history-tasks`)

    elements.returnTargetTask.innerHTML = '<option value="">-- 选择退回节点 --</option>'
    historyTasks.forEach(t => {
        const option = document.createElement('option')
        option.value = t.id
        option.textContent = `${t.id} - ${t.name || '未命名'}`
        elements.returnTargetTask.appendChild(option)
    })

    elements.returnReason.value = ''
    elements.returnTaskModal.classList.add('show')
}

function closeReturnTaskModal() {
    elements.returnTaskModal.classList.remove('show')
    currentReturnTaskId = null
}

// 确认退回任务
async function confirmReturnTask() {
    const targetTaskId = elements.returnTargetTask.value
    if (!targetTaskId) {
        alert('请选择要退回到的节点')
        return
    }

    if (!confirm('确定要退回到此节点吗？这将重置流程状态。')) return

    const result = await api.post(`/api/instances/${state.currentInstanceId}/jump-to-task`, { taskId: targetTaskId })

    if (result.success) {
        alert('退回成功')
        closeReturnTaskModal()
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
        elements.identityLinkList.innerHTML = identitylinks.map(link => `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 6px; border-bottom: 1px solid #eee;">
                <span>${link.userId} (${link.type === 'candidate' ? '候选人' : '审批人'})</span>
                <button class="btn btn-small btn-danger" onclick="removeIdentityLink('${link.userId}', '${link.type}')">删除</button>
            </div>
        `).join('')
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

// 启动应用
init()
