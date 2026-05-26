const express = require('express')
const path = require('path')
const fs = require('fs')
const { exec } = require('child_process')
const cors = require('cors')
const mysql = require('mysql2/promise')
const { Pool } = require('pg')
const initSqlJs = require('sql.js')

const app = express()
const PORT = 34567

// 获取应用根目录（处理 pkg 打包后的路径）
function getAppRoot() {
    if (process.pkg) {
        return path.dirname(process.execPath)
    }
    return path.join(__dirname, '..')
}

const CONFIG_DB_PATH = path.join(getAppRoot(), 'config.db')

let activitiDb = null
let dbConfig = null
let localDb = null

app.use(cors())
app.use(express.json())

// 处理静态资源路径
function getPublicPath() {
    if (process.pkg) {
        // 尝试多个可能的路径
        const execDir = path.dirname(process.execPath)
        const possiblePaths = [
            path.join(execDir, 'src', 'public'),
            path.join(execDir, 'public'),
            path.join(execDir, 'snapshot', 'src', 'public'),
            path.join(__dirname, 'public')
        ]
        
        for (const p of possiblePaths) {
            const indexPath = path.join(p, 'index.html')
            if (fs.existsSync(indexPath)) {
                console.log(`[DEBUG] Found public path: ${p}`)
                return p
            }
        }
        
        // 如果都没找到，使用第一个备选路径并输出警告
        console.warn(`[WARN] Could not find public/index.html in any expected location`)
        console.warn(`[WARN] Tried paths: ${possiblePaths.join(', ')}`)
        console.warn(`[WARN] Checked __dirname: ${__dirname}`)
        console.warn(`[WARN] Checked execPath: ${process.execPath}`)
        return possiblePaths[0]
    }
    return path.join(__dirname, 'public')
}

const publicPath = getPublicPath()
console.log(`[INFO] Static files path: ${publicPath}`)
app.use(express.static(publicPath))

async function initLocalDb() {
    const SQL = await initSqlJs()
    
    if (fs.existsSync(CONFIG_DB_PATH)) {
        const fileBuffer = fs.readFileSync(CONFIG_DB_PATH)
        localDb = new SQL.Database(fileBuffer)
    } else {
        localDb = new SQL.Database()
    }
    
    localDb.run(`
        CREATE TABLE IF NOT EXISTS connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            db_type TEXT NOT NULL,
            host TEXT NOT NULL,
            port INTEGER NOT NULL,
            database TEXT NOT NULL,
            username TEXT NOT NULL,
            password TEXT
        )
    `)
    saveLocalDb()
}

function saveLocalDb() {
    const data = localDb.export()
    const buffer = Buffer.from(data)
    fs.writeFileSync(CONFIG_DB_PATH, buffer)
}

function openBrowser(url) {
    if (process.platform === 'win32') {
        exec(`start ${url}`)
    } else if (process.platform === 'darwin') {
        exec(`open ${url}`)
    } else {
        exec(`xdg-open ${url}`)
    }
}

// ========== API路由 ==========

app.post('/api/test-connection', async (req, res) => {
    const config = req.body
    try {
        await testConnection(config)
        res.json({ success: true, message: '连接成功！' })
    } catch (error) {
        res.json({ success: false, message: error.message })
    }
})

app.post('/api/save-connection', (req, res) => {
    const config = req.body
    localDb.run(`
        INSERT INTO connections (name, db_type, host, port, database, username, password)
        VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [config.name, config.dbType, config.host, config.port, config.database, config.username, config.password])
    saveLocalDb()
    
    const result = localDb.exec('SELECT last_insert_rowid() as id')
    const id = result[0]?.values[0]?.[0] || 0
    res.json({ success: true, id })
})

app.get('/api/connections', (req, res) => {
    const result = localDb.exec('SELECT id, name, db_type, host, port, database, username FROM connections')
    const connections = result.length > 0 ? result[0].values.map(row => ({
        id: row[0], name: row[1], db_type: row[2], host: row[3], port: row[4], database: row[5], username: row[6]
    })) : []
    res.json(connections)
})

app.delete('/api/connections/:id', (req, res) => {
    localDb.run('DELETE FROM connections WHERE id = ?', [parseInt(req.params.id)])
    saveLocalDb()
    res.json({ success: true })
})

app.post('/api/connect', async (req, res) => {
    const config = req.body
    try {
        await testConnection(config)
        dbConfig = config
        activitiDb = await createConnection(config)
        res.json({ success: true, message: '已连接到数据库！' })
    } catch (error) {
        res.json({ success: false, message: error.message })
    }
})

app.post('/api/disconnect', (req, res) => {
    if (activitiDb) {
        if (dbConfig?.dbType === 'postgres') {
            activitiDb.end()
        } else {
            activitiDb.end()
        }
    }
    activitiDb = null
    dbConfig = null
    res.json({ success: true })
})

app.get('/api/connection-status', (req, res) => {
    res.json({ connected: !!activitiDb, config: dbConfig ? { ...dbConfig, password: undefined } : null })
})

app.get('/api/instances', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const page = parseInt(req.query.page) || 1
        const size = parseInt(req.query.size) || 10
        const keyword = req.query.keyword || ''
        const status = req.query.status || 'running'
        const offset = (page - 1) * size
        
        let result
        if (status === 'finished') {
            result = await getFinishedProcessInstances(activitiDb, dbConfig.dbType, offset, size, keyword)
        } else {
            result = await getProcessInstances(activitiDb, dbConfig.dbType, offset, size, keyword)
        }
        res.json(result)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/finished-instances', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const page = parseInt(req.query.page) || 1
        const size = parseInt(req.query.size) || 10
        const keyword = req.query.keyword || ''
        const offset = (page - 1) * size
        
        const result = await getFinishedProcessInstances(activitiDb, dbConfig.dbType, offset, size, keyword)
        res.json(result)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/instances/:id', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const instance = await getProcessInstanceDetail(activitiDb, dbConfig.dbType, req.params.id)
        res.json(instance)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/instances/:id/variables', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const variables = await getProcessVariables(activitiDb, dbConfig.dbType, req.params.id)
        res.json(variables)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/instances/:id/variables', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        await setProcessVariable(activitiDb, dbConfig.dbType, req.params.id, req.body)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.delete('/api/instances/:id/variables/:name', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        await deleteProcessVariable(activitiDb, dbConfig.dbType, req.params.id, req.params.name)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/definitions', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const definitions = await getProcessDefinitions(activitiDb, dbConfig.dbType)
        res.json(definitions)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/definitions/:id/xml', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const xml = await getProcessDefinitionXml(activitiDb, dbConfig.dbType, req.params.id)
        res.json({ xml })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.put('/api/definitions/:id/xml', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const { xml } = req.body
        await updateProcessDefinitionXml(activitiDb, dbConfig.dbType, req.params.id, xml)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/definitions/:id/affected-instances', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const result = await getAffectedInstances(activitiDb, dbConfig.dbType, req.params.id)
        res.json(result)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/instances/:id/history-tasks', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const tasks = await getHistoryTasks(activitiDb, dbConfig.dbType, req.params.id)
        res.json(tasks)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/instances/:id/jump-to-task', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const { taskId } = req.body
        await jumpToHistoryTask(activitiDb, dbConfig.dbType, req.params.id, taskId)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/instances/:id/jump-to-finished-task', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const { taskId } = req.body
        await jumpToFinishedHistoryTask(activitiDb, dbConfig.dbType, req.params.id, taskId)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/tasks/:taskId/set-assignee', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const { assignee } = req.body
        await setTaskAssignee(activitiDb, dbConfig.dbType, req.params.taskId, assignee)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.post('/api/tasks/:taskId/add-identitylink', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const { userId, type } = req.body
        await addTaskIdentityLink(activitiDb, dbConfig.dbType, req.params.taskId, userId, type)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.delete('/api/tasks/:taskId/identitylink', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const userId = req.query.userId
        const type = req.query.type
        await deleteTaskIdentityLink(activitiDb, dbConfig.dbType, req.params.taskId, userId, type)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.delete('/api/instances/:id', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const instanceId = req.params.id
        await deleteProcessInstance(activitiDb, dbConfig.dbType, instanceId)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.get('/api/tasks/:taskId/identitylinks', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const identitylinks = await getTaskIdentityLinks(activitiDb, dbConfig.dbType, req.params.taskId)
        res.json(identitylinks)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

// ========== 数据库操作函数 ==========

async function testConnection(config) {
    let conn
    try {
        if (config.dbType === 'mysql') {
            conn = await mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database
            })
            await conn.ping()
        } else if (config.dbType === 'postgres') {
            conn = new Pool({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database
            })
            await conn.query('SELECT 1')
        } else if (config.dbType === 'hgdatabase') {
            conn = new Pool({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database
            })
            await conn.query('SELECT 1')
        }
    } finally {
        if (conn) {
            if (config.dbType === 'mysql') await conn.end()
            else if (config.dbType === 'postgres' || config.dbType === 'hgdatabase') await conn.end()
        }
    }
}

async function createConnection(config) {
    if (config.dbType === 'mysql') {
        return await mysql.createConnection({
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            database: config.database
        })
    } else if (config.dbType === 'postgres') {
        return new Pool({
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            database: config.database
        })
    } else if (config.dbType === 'hgdatabase') {
        return new Pool({
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            database: config.database
        })
    }
}

async function query(db, dbType, sql, params = []) {
    if (dbType === 'mysql') {
        const [rows] = await db.execute(sql, params)
        return rows
    } else if (dbType === 'postgres') {
        const result = await db.query(sql, params)
        return result.rows
    } else if (dbType === 'hgdatabase') {
        const result = await db.query(sql, params)
        return result.rows
    }
}

async function getProcessInstances(db, dbType, offset, size, keyword) {
    let sql = `
        SELECT 
            e.ID_ as id,
            e.PROC_DEF_ID_ as procDefId,
            pd.NAME_ as procDefName,
            pd.KEY_ as procDefKey,
            e.START_TIME_ as startTime,
            e.START_USER_ID_ as startUserId,
            e.BUSINESS_KEY_ as businessKey,
            su.username as startUserName,
            su.realname as startUserRealname
        FROM ACT_RU_EXECUTION e
        LEFT JOIN ACT_RE_PROCDEF pd ON e.PROC_DEF_ID_ = pd.ID_
        LEFT JOIN sys_user su ON e.START_USER_ID_ = su.id
        WHERE e.PARENT_ID_ IS NULL
    `
    const params = []
    
    if (keyword) {
        const kw = `%${keyword}%`
        if (dbType === 'mysql') {
            sql += ' AND (pd.NAME_ LIKE ? OR pd.KEY_ LIKE ? OR e.BUSINESS_KEY_ LIKE ?)'
            params.push(kw, kw, kw)
        } else {
            sql += ' AND (pd.NAME_ ILIKE $1 OR pd.KEY_ ILIKE $1 OR e.BUSINESS_KEY_ ILIKE $1)'
            params.push(kw)
        }
    }
    
    sql += ' ORDER BY e.START_TIME_ DESC'
    
    let countSql = 'SELECT COUNT(*) as total FROM ACT_RU_EXECUTION e LEFT JOIN ACT_RE_PROCDEF pd ON e.PROC_DEF_ID_ = pd.ID_ LEFT JOIN sys_user su ON e.START_USER_ID_ = su.id WHERE e.PARENT_ID_ IS NULL'
    const countParams = []
    
    if (keyword) {
        const kw = `%${keyword}%`
        if (dbType === 'mysql') {
            countSql += ' AND (pd.NAME_ LIKE ? OR pd.KEY_ LIKE ? OR e.BUSINESS_KEY_ LIKE ?)'
            countParams.push(kw, kw, kw)
        } else {
            countSql += ' AND (pd.NAME_ ILIKE $1 OR pd.KEY_ ILIKE $1 OR e.BUSINESS_KEY_ ILIKE $1)'
            countParams.push(kw)
        }
    }
    
    let total
    if (dbType === 'mysql') {
        const [rows] = await db.execute(countSql, countParams)
        total = rows[0]?.total || 0
    } else {
        const result = await db.query(countSql, countParams)
        total = parseInt(result.rows[0]?.total || 0)
    }
    
    if (dbType === 'mysql') {
        sql += ' LIMIT ? OFFSET ?'
        params.push(size, offset)
    } else {
        sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
        params.push(size, offset)
    }
    
    let instances
    if (dbType === 'mysql') {
        const [rows] = await db.execute(sql, params)
        instances = rows
    } else {
        const result = await db.query(sql, params)
        instances = result.rows
    }
    
    for (const inst of instances) {
        let taskSql = `
            SELECT t.ID_ as id, t.NAME_ as name, t.ASSIGNEE_ as assignee, t.CREATE_TIME_ as createTime,
                   su.username as assigneeName, su.realname as assigneeRealname
            FROM ACT_RU_TASK t
            LEFT JOIN sys_user su ON t.ASSIGNEE_ = su.id
            WHERE t.PROC_INST_ID_ = ?
        `
        if (dbType === 'postgres') {
            taskSql = taskSql.replace(/\?/, '$1')
        }
        if (dbType === 'mysql') {
            const [rows] = await db.execute(taskSql, [inst.id])
            inst.currentTasks = rows
        } else {
            const result = await db.query(taskSql, [inst.id])
            inst.currentTasks = result.rows
        }
        
        inst.isFinished = inst.currentTasks.length === 0
        
        if (!inst.isFinished) {
            let historySql = `
                SELECT END_TIME_ 
                FROM ACT_HI_PROCINST 
                WHERE PROC_INST_ID_ = ?
            `
            if (dbType === 'postgres') {
                historySql = historySql.replace(/\?/, '$1')
            }
            if (dbType === 'mysql') {
                const [rows] = await db.execute(historySql, [inst.id])
                inst.isFinished = rows.length > 0 && rows[0].END_TIME_ !== null
            } else {
                const result = await db.query(historySql, [inst.id])
                inst.isFinished = result.rows.length > 0 && result.rows[0].END_TIME_ !== null
            }
        }
    }
    
    return { instances, total }
}

async function getProcessInstanceDetail(db, dbType, instanceId) {
    let sql = `
        SELECT 
            e.ID_ as id,
            e.PROC_DEF_ID_ as procDefId,
            pd.NAME_ as procDefName,
            pd.KEY_ as procDefKey,
            e.START_TIME_ as startTime,
            e.START_USER_ID_ as startUserId,
            e.BUSINESS_KEY_ as businessKey,
            su.username as startUserName,
            su.realname as startUserRealname
        FROM ACT_RU_EXECUTION e
        LEFT JOIN ACT_RE_PROCDEF pd ON e.PROC_DEF_ID_ = pd.ID_
        LEFT JOIN sys_user su ON e.START_USER_ID_ = su.id
        WHERE e.ID_ = ? AND e.PARENT_ID_ IS NULL
    `
    
    let instance
    let isFinished = false
    
    if (dbType === 'mysql') {
        const [rows] = await db.execute(sql, [instanceId])
        instance = rows[0]
    } else {
        sql = sql.replace(/\?/, '$1')
        const result = await db.query(sql, [instanceId])
        instance = result.rows[0]
    }
    
    if (!instance) {
        let historySql = `
            SELECT 
                h.ID_ as id,
                h.PROC_DEF_ID_ as procDefId,
                pd.NAME_ as procDefName,
                pd.KEY_ as procDefKey,
                h.START_TIME_ as startTime,
                h.START_USER_ID_ as startUserId,
                h.BUSINESS_KEY_ as businessKey,
                h.END_TIME_ as endTime,
                su.username as startUserName,
                su.realname as startUserRealname
            FROM ACT_HI_PROCINST h
            LEFT JOIN ACT_RE_PROCDEF pd ON h.PROC_DEF_ID_ = pd.ID_
            LEFT JOIN sys_user su ON h.START_USER_ID_ = su.id
            WHERE h.ID_ = ?
        `
        if (dbType === 'mysql') {
            const [rows] = await db.execute(historySql, [instanceId])
            instance = rows[0]
        } else {
            historySql = historySql.replace(/\?/, '$1')
            const result = await db.query(historySql, [instanceId])
            instance = result.rows[0]
        }
        
        if (instance) {
            isFinished = true
        }
    }
    
    if (instance) {
        instance.isFinished = isFinished
        
        let taskSql = `
            SELECT t.ID_ as id, t.NAME_ as name, t.ASSIGNEE_ as assignee, t.CREATE_TIME_ as createTime,
                   su.username as assigneeName, su.realname as assigneeRealname
            FROM ACT_RU_TASK t
            LEFT JOIN sys_user su ON t.ASSIGNEE_ = su.id
            WHERE t.PROC_INST_ID_ = ?
        `
        if (dbType === 'postgres') {
            taskSql = taskSql.replace(/\?/, '$1')
        }
        
        let rows
        if (dbType === 'mysql') {
            const [result] = await db.execute(taskSql, [instanceId])
            rows = result
        } else {
            const result = await db.query(taskSql, [instanceId])
            rows = result.rows
        }
        
        for (const row of rows) {
            row.candidates = []
        }
        
        if (rows.length > 0) {
            const taskIds = rows.map(r => r.id)
            const placeholders = dbType === 'mysql' 
                ? taskIds.map(() => '?').join(',')
                : taskIds.map((_, i) => `$${i + 1}`).join(',')
            
            let candidateSql = `
                SELECT il.TASK_ID_ as taskId, il.USER_ID_ as userId, su.username, su.realname
                FROM ACT_RU_IDENTITYLINK il
                LEFT JOIN sys_user su ON il.USER_ID_ = su.id
                WHERE il.TASK_ID_ IN (${placeholders}) AND il.TYPE_ = 'candidate' AND il.USER_ID_ IS NOT NULL
            `
            
            let candidates
            if (dbType === 'mysql') {
                const [result] = await db.execute(candidateSql, taskIds)
                candidates = result
            } else {
                const result = await db.query(candidateSql, taskIds)
                candidates = result.rows
            }
            
            const candidateMap = {}
            for (const c of candidates) {
                if (!candidateMap[c.taskId]) {
                    candidateMap[c.taskId] = []
                }
                candidateMap[c.taskId].push(c)
            }
            
            for (const row of rows) {
                row.candidates = candidateMap[row.id] || []
            }
        }
        
        instance.currentTasks = rows
    }
    
    return instance
}

async function getFinishedProcessInstances(db, dbType, offset, size, keyword) {
    let sql = `
        SELECT 
            h.ID_ as id,
            h.PROC_DEF_ID_ as procDefId,
            pd.NAME_ as procDefName,
            pd.KEY_ as procDefKey,
            h.START_TIME_ as startTime,
            h.END_TIME_ as endTime,
            h.START_USER_ID_ as startUserId,
            h.BUSINESS_KEY_ as businessKey,
            su.username as startUserName,
            su.realname as startUserRealname
        FROM ACT_HI_PROCINST h
        LEFT JOIN ACT_RE_PROCDEF pd ON h.PROC_DEF_ID_ = pd.ID_
        LEFT JOIN sys_user su ON h.START_USER_ID_ = su.id
        WHERE h.END_TIME_ IS NOT NULL
    `
    const params = []
    
    if (keyword) {
        const kw = `%${keyword}%`
        if (dbType === 'mysql') {
            sql += ' AND (pd.NAME_ LIKE ? OR pd.KEY_ LIKE ? OR h.BUSINESS_KEY_ LIKE ?)'
            params.push(kw, kw, kw)
        } else {
            sql += ' AND (pd.NAME_ ILIKE $1 OR pd.KEY_ ILIKE $1 OR h.BUSINESS_KEY_ ILIKE $1)'
            params.push(kw)
        }
    }
    
    sql += ' ORDER BY h.END_TIME_ DESC'
    
    let countSql = 'SELECT COUNT(*) as total FROM ACT_HI_PROCINST h LEFT JOIN ACT_RE_PROCDEF pd ON h.PROC_DEF_ID_ = pd.ID_ LEFT JOIN sys_user su ON h.START_USER_ID_ = su.id WHERE h.END_TIME_ IS NOT NULL'
    const countParams = []
    
    if (keyword) {
        const kw = `%${keyword}%`
        if (dbType === 'mysql') {
            countSql += ' AND (pd.NAME_ LIKE ? OR pd.KEY_ LIKE ? OR h.BUSINESS_KEY_ LIKE ?)'
            countParams.push(kw, kw, kw)
        } else {
            countSql += ' AND (pd.NAME_ ILIKE $1 OR pd.KEY_ ILIKE $1 OR h.BUSINESS_KEY_ ILIKE $1)'
            countParams.push(kw)
        }
    }
    
    let total
    if (dbType === 'mysql') {
        const [rows] = await db.execute(countSql, countParams)
        total = rows[0]?.total || 0
    } else {
        const result = await db.query(countSql, countParams)
        total = parseInt(result.rows[0]?.total || 0)
    }
    
    if (dbType === 'mysql') {
        sql += ' LIMIT ? OFFSET ?'
        params.push(size, offset)
    } else {
        sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
        params.push(size, offset)
    }
    
    let instances
    if (dbType === 'mysql') {
        const [rows] = await db.execute(sql, params)
        instances = rows
    } else {
        const result = await db.query(sql, params)
        instances = result.rows
    }
    
    for (const inst of instances) {
        inst.isFinished = true
    }
    
    return { instances, total }
}

async function getProcessVariables(db, dbType, instanceId) {
    let sql = `
        SELECT NAME_ as name, TYPE_ as type, TEXT_ as textValue, DOUBLE_ as doubleValue, LONG_ as longValue
        FROM ACT_RU_VARIABLE
        WHERE PROC_INST_ID_ = ?
    `
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/, '$1')
    }
    
    let variables
    if (dbType === 'mysql') {
        const [rows] = await db.execute(sql, [instanceId])
        variables = rows
    } else {
        const result = await db.query(sql, [instanceId])
        variables = result.rows
    }
    
    return variables.map(v => {
        let value
        switch (v.type) {
            case 'string': value = v.textValue; break
            case 'long': value = v.longValue; break
            case 'double': value = v.doubleValue; break
            default: value = v.textValue
        }
        return { name: v.name, type: v.type, value }
    })
}

async function setProcessVariable(db, dbType, instanceId, variable) {
    let deleteSql = 'DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = ? AND NAME_ = ?'
    if (dbType === 'postgres') {
        deleteSql = deleteSql.replace(/\?/g, (_, i) => `$${i + 1}`)
    }
    await query(db, dbType, deleteSql, [instanceId, variable.name])
    
    let insertSql
    let params
    
    if (dbType === 'mysql') {
        insertSql = `
            INSERT INTO ACT_RU_VARIABLE (ID_, PROC_INST_ID_, NAME_, TYPE_, TEXT_, DOUBLE_, LONG_)
            VALUES (UUID(), ?, ?, ?, ?, ?, ?)
        `
        params = [instanceId, variable.name, variable.type]
    } else {
        insertSql = `
            INSERT INTO ACT_RU_VARIABLE (ID_, PROC_INST_ID_, NAME_, TYPE_, TEXT_, DOUBLE_, LONG_)
            VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6)
        `
        params = [instanceId, variable.name, variable.type]
    }
    
    switch (variable.type) {
        case 'string':
            params.push(variable.value, null, null)
            break
        case 'long':
            params.push(null, null, parseInt(variable.value))
            break
        case 'double':
            params.push(null, parseFloat(variable.value), null)
            break
        default:
            params.push(String(variable.value), null, null)
    }
    
    await query(db, dbType, insertSql, params)
}

async function deleteProcessVariable(db, dbType, instanceId, name) {
    let sql = 'DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = ? AND NAME_ = ?'
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/g, (_, i) => `$${i + 1}`)
    }
    await query(db, dbType, sql, [instanceId, name])
}

async function getProcessDefinitions(db, dbType) {
    let sql
    if (dbType === 'mysql') {
        sql = `
            SELECT ID_ as id, KEY_ as \`key\`, NAME_ as name, VERSION_ as version, RESOURCE_NAME_ as resourceName
            FROM ACT_RE_PROCDEF
            ORDER BY KEY_, VERSION_ DESC
        `
    } else {
        sql = `
            SELECT ID_ as id, KEY_ as key, NAME_ as name, VERSION_ as version, RESOURCE_NAME_ as resourceName
            FROM ACT_RE_PROCDEF
            ORDER BY KEY_, VERSION_ DESC
        `
    }
    return await query(db, dbType, sql)
}

async function getProcessDefinitionXml(db, dbType, definitionId) {
    let sql
    if (dbType === 'mysql') {
        sql = `
            SELECT b.BYTES_ as bytes
            FROM ACT_RE_PROCDEF p
            LEFT JOIN ACT_GE_BYTEARRAY b ON p.DEPLOYMENT_ID_ = b.DEPLOYMENT_ID_
            WHERE p.ID_ = ? AND b.NAME_ LIKE '%.bpmn%'
            ORDER BY b.ID_ DESC
            LIMIT 1
        `
    } else {
        sql = `
            SELECT b.BYTES_ as bytes
            FROM ACT_RE_PROCDEF p
            LEFT JOIN ACT_GE_BYTEARRAY b ON p.DEPLOYMENT_ID_ = b.DEPLOYMENT_ID_
            WHERE p.ID_ = $1 AND b.NAME_ ILIKE '%.bpmn%'
            ORDER BY b.ID_ DESC
            LIMIT 1
        `
    }
    
    let rows
    if (dbType === 'mysql') {
        const [result] = await db.execute(sql, [definitionId])
        rows = result
    } else {
        const result = await db.query(sql, [definitionId])
        rows = result.rows
    }
    
    if (rows.length > 0) {
        const bytes = rows[0].bytes
        if (Buffer.isBuffer(bytes)) {
            return bytes.toString('utf8')
        } else if (bytes instanceof Uint8Array) {
            return Buffer.from(bytes).toString('utf8')
        } else if (typeof bytes === 'string') {
            return bytes
        }
    }
    return ''
}

async function updateProcessDefinitionXml(db, dbType, definitionId, xml) {
    let sql = `
        SELECT b.ID_ as byteArrayId
        FROM ACT_RE_PROCDEF p
        LEFT JOIN ACT_GE_BYTEARRAY b ON p.DEPLOYMENT_ID_ = b.DEPLOYMENT_ID_
        WHERE p.ID_ = ? AND b.NAME_ LIKE '%.bpmn%'
        ORDER BY b.ID_ DESC
        LIMIT 1
    `
    
    let params = [definitionId]
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/, '$1')
    }
    
    let rows
    if (dbType === 'mysql') {
        const [result] = await db.execute(sql, params)
        rows = result
    } else {
        const result = await db.query(sql, params)
        rows = result.rows
    }
    
    if (rows.length === 0) {
        throw new Error('流程定义或BPMN文件不存在')
    }
    
    const byteArrayId = rows[0].byteArrayId
    const bytes = Buffer.from(xml, 'utf8')
    
    let updateSql
    if (dbType === 'mysql') {
        updateSql = 'UPDATE ACT_GE_BYTEARRAY SET BYTES_ = ? WHERE ID_ = ?'
    } else {
        updateSql = 'UPDATE ACT_GE_BYTEARRAY SET BYTES_ = $1 WHERE ID_ = $2'
    }
    
    if (dbType === 'mysql') {
        await db.execute(updateSql, [bytes, byteArrayId])
    } else {
        await db.query(updateSql, [bytes, byteArrayId])
    }
}

async function getAffectedInstances(db, dbType, definitionId) {
    let sql
    if (dbType === 'mysql') {
        sql = `
            SELECT 
                COUNT(*) as total,
                MIN(START_TIME_) as earliestStart,
                MAX(START_TIME_) as latestStart
            FROM ACT_HI_PROCINST
            WHERE PROC_DEF_ID_ = ?
        `
    } else {
        sql = `
            SELECT 
                COUNT(*) as total,
                MIN(START_TIME_) as earliestStart,
                MAX(START_TIME_) as latestStart
            FROM ACT_HI_PROCINST
            WHERE PROC_DEF_ID_ = $1
        `
    }
    
    let rows
    if (dbType === 'mysql') {
        const [result] = await db.execute(sql, [definitionId])
        rows = result
    } else {
        const result = await db.query(sql, [definitionId])
        rows = result.rows
    }
    
    if (rows.length > 0) {
        return {
            total: parseInt(rows[0].total || 0),
            earliestStart: rows[0].earliestStart,
            latestStart: rows[0].latestStart
        }
    }
    
    return { total: 0, earliestStart: null, latestStart: null }
}

async function getHistoryTasks(db, dbType, instanceId) {
    let sql = `
        SELECT 
            t.ID_ as id, 
            t.NAME_ as name, 
            t.ASSIGNEE_ as assignee, 
            t.START_TIME_ as startTime, 
            t.END_TIME_ as endTime,
            su.username as assigneeName,
            su.realname as assigneeRealname
        FROM ACT_HI_TASKINST t
        LEFT JOIN sys_user su ON t.ASSIGNEE_ = su.id
        WHERE t.PROC_INST_ID_ = ?
        ORDER BY t.START_TIME_ DESC
    `
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/, '$1')
    }
    return await query(db, dbType, sql, [instanceId])
}

async function jumpToHistoryTask(db, dbType, instanceId, targetTaskId) {
    let sql, params
    
    // 1. 查询历史任务数据
    sql = `
        SELECT 
            t.ID_ as task_id,
            t.NAME_ as task_name,
            t.TASK_DEF_KEY_,
            t.PROC_DEF_ID_,
            t.CREATE_TIME_ as task_create_time,
            t.ASSIGNEE_ as task_assignee,
            t.PRIORITY_,
            p.ID_ as proc_inst_id,
            p.BUSINESS_KEY_,
            p.START_TIME_,
            p.START_USER_ID_,
            p.PROC_DEF_ID_ as proc_def_id
        FROM ACT_HI_TASKINST t
        JOIN ACT_HI_PROCINST p ON t.PROC_INST_ID_ = p.ID_
        WHERE t.ID_ = ? AND t.PROC_INST_ID_ = ?
    `
    params = [targetTaskId, instanceId]
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/g, (_, i) => `$${i + 1}`)
    }
    
    let taskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(sql, params)
        taskRows = result
    } else {
        const result = await db.query(sql, params)
        taskRows = result.rows
    }
    
    if (taskRows.length === 0) {
        throw new Error('历史任务不存在')
    }
    
    const taskData = taskRows[0]
    
    // 2. 查询目标任务之后的所有历史记录，准备删除
    sql = `SELECT ID_, START_TIME_ FROM ACT_HI_TASKINST WHERE PROC_INST_ID_ = ? ORDER BY START_TIME_ ASC`
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/, '$1')
    }
    
    let allTaskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(sql, [instanceId])
        allTaskRows = result
    } else {
        const result = await db.query(sql, [instanceId])
        allTaskRows = result.rows
    }
    
    // 找到目标任务的索引，收集之后要删除的任务ID
    let targetTaskIndex = -1
    const taskIdsToDelete = []
    for (let i = 0; i < allTaskRows.length; i++) {
        if (allTaskRows[i].ID_ === targetTaskId) {
            targetTaskIndex = i
        } else if (targetTaskIndex !== -1) {
            taskIdsToDelete.push(allTaskRows[i].ID_)
        }
    }
    
    if (dbType === 'mysql') {
        // 3. 删除当前运行时的任务、变量、身份关联
        await db.execute('DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ IN (SELECT ID_ FROM ACT_RU_TASK WHERE PROC_INST_ID_ = ?)', [instanceId])
        await db.execute('DELETE FROM ACT_RU_TASK WHERE PROC_INST_ID_ = ?', [instanceId])
        await db.execute('DELETE FROM ACT_RU_EXECUTION WHERE PROC_INST_ID_ = ? AND PARENT_ID_ IS NOT NULL', [instanceId])
        await db.execute('DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = ?', [instanceId])
        
        // 4. 更新执行实例状态，保持开始时间和发起人
        sql = `
            UPDATE ACT_RU_EXECUTION 
            SET IS_ACTIVE_ = 1, IS_SCOPE_ = 1,
                START_TIME_ = ?, START_USER_ID_ = ?
            WHERE ID_ = ?
        `
        await db.execute(sql, [taskData.START_TIME_, taskData.START_USER_ID_, instanceId])
        
        // 5. 创建任务，使用原来的任务ID
        sql = `
            INSERT INTO ACT_RU_TASK (
                ID_, REV_, NAME_, PRIORITY_, 
                CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
            ) VALUES (?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, 1)
        `
        await db.execute(sql, [
            targetTaskId, 
            taskData.task_name, 
            taskData.PRIORITY_ || 50, 
            taskData.task_create_time, 
            instanceId, 
            instanceId, 
            taskData.PROC_DEF_ID_, 
            taskData.TASK_DEF_KEY_
        ])
        
        // 6. 恢复身份关联
        sql = `
            SELECT TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
            FROM ACT_HI_IDENTITYLINK
            WHERE TASK_ID_ = ? OR PROC_INST_ID_ = ?
        `
        const [identityLinks] = await db.execute(sql, [targetTaskId, instanceId])
        
        for (const link of identityLinks) {
            const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            sql = `
                INSERT INTO ACT_RU_IDENTITYLINK (
                    ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                ) VALUES (?, 1, ?, ?, ?, ?, ?)
            `
            await db.execute(sql, [linkId, link.TYPE_, link.USER_ID_, link.GROUP_ID_, targetTaskId, instanceId])
        }
        
        // 7. 恢复变量
        sql = `
            SELECT NAME_, VAR_TYPE_, TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
            FROM ACT_HI_VARINST 
            WHERE PROC_INST_ID_ = ? 
              AND NAME_ IS NOT NULL
        `
        const [varRows] = await db.execute(sql, [instanceId])
        
        for (const v of varRows) {
            const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            const varType = v.VAR_TYPE_ || 'string'
            
            sql = `
                INSERT INTO ACT_RU_VARIABLE (
                    ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                    TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            await db.execute(sql, [
                varId, 
                v.NAME_, 
                varType, 
                instanceId, 
                v.TEXT_, 
                v.TEXT2_, 
                v.DOUBLE_, 
                v.LONG_, 
                v.BYTEARRAY_ID_
            ])
        }
        
        // 8. 删除目标任务之后的历史活动
        if (taskIdsToDelete.length > 0) {
            const placeholders = taskIdsToDelete.map(() => '?').join(',')
            sql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
            await db.execute(sql, taskIdsToDelete)
            
            // 9. 删除目标任务之后的历史任务
            sql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
            await db.execute(sql, taskIdsToDelete)
        }
        
        // 10. 删除活动历史
        sql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = ?`
        await db.execute(sql, [instanceId])
        
        // 11. 更新目标历史任务
        sql = `
            UPDATE ACT_HI_TASKINST 
            SET END_TIME_ = NULL, DELETE_REASON_ = NULL
            WHERE ID_ = ?
        `
        await db.execute(sql, [targetTaskId])
        
        // 12. 更新历史流程实例
        sql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = ?`
        await db.execute(sql, [instanceId])
    } else {
        // 瀚高/PostgreSQL 版本
        await db.query('DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ IN (SELECT ID_ FROM ACT_RU_TASK WHERE PROC_INST_ID_ = $1)', [instanceId])
        await db.query('DELETE FROM ACT_RU_TASK WHERE PROC_INST_ID_ = $1', [instanceId])
        await db.query('DELETE FROM ACT_RU_EXECUTION WHERE PROC_INST_ID_ = $1 AND PARENT_ID_ IS NOT NULL', [instanceId])
        await db.query('DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = $1', [instanceId])
        
        sql = `
            UPDATE ACT_RU_EXECUTION 
            SET IS_ACTIVE_ = 1, IS_SCOPE_ = 1,
                START_TIME_ = $1, START_USER_ID_ = $2
            WHERE ID_ = $3
        `
        await db.query(sql, [taskData.START_TIME_, taskData.START_USER_ID_, instanceId])
        
        sql = `
            INSERT INTO ACT_RU_TASK (
                ID_, REV_, NAME_, PRIORITY_, 
                CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
            ) VALUES ($1, 1, $2, $3, $4, NULL, $5, $6, $7, $8, 1)
        `
        await db.query(sql, [
            targetTaskId, 
            taskData.task_name, 
            taskData.PRIORITY_ || 50, 
            taskData.task_create_time, 
            instanceId, 
            instanceId, 
            taskData.PROC_DEF_ID_, 
            taskData.TASK_DEF_KEY_
        ])
        
        sql = `
            SELECT TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
            FROM ACT_HI_IDENTITYLINK
            WHERE TASK_ID_ = $1 OR PROC_INST_ID_ = $2
        `
        const identityResult = await db.query(sql, [targetTaskId, instanceId])
        
        for (const link of identityResult.rows) {
            const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            sql = `
                INSERT INTO ACT_RU_IDENTITYLINK (
                    ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                ) VALUES ($1, 1, $2, $3, $4, $5, $6)
            `
            await db.query(sql, [linkId, link.TYPE_, link.USER_ID_, link.GROUP_ID_, targetTaskId, instanceId])
        }
        
        sql = `
            SELECT NAME_, VAR_TYPE_, TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
            FROM ACT_HI_VARINST 
            WHERE PROC_INST_ID_ = $1 
              AND NAME_ IS NOT NULL
        `
        const varResult = await db.query(sql, [instanceId])
        
        for (const v of varResult.rows) {
            const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            const varType = v.VAR_TYPE_ || 'string'
            
            sql = `
                INSERT INTO ACT_RU_VARIABLE (
                    ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                    TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
            `
            await db.query(sql, [
                varId, 
                v.NAME_, 
                varType, 
                instanceId, 
                v.TEXT_, 
                v.TEXT2_, 
                v.DOUBLE_, 
                v.LONG_, 
                v.BYTEARRAY_ID_
            ])
        }
        
        // 删除目标任务之后的历史
        if (taskIdsToDelete.length > 0) {
            const placeholders = taskIdsToDelete.map((_, i) => `$${i + 1}`).join(',')
            sql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
            await db.query(sql, taskIdsToDelete)
            
            sql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
            await db.query(sql, taskIdsToDelete)
        }
        
        sql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = $1`
        await db.query(sql, [instanceId])
        
        sql = `
            UPDATE ACT_HI_TASKINST 
            SET END_TIME_ = NULL, DELETE_REASON_ = NULL
            WHERE ID_ = $1
        `
        await db.query(sql, [targetTaskId])
        
        sql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = $1`
        await db.query(sql, [instanceId])
    }
}

async function jumpToFinishedHistoryTask(db, dbType, instanceId, targetTaskId) {
    let sql, params
    
    // 1. 查询历史任务数据
    sql = `
        SELECT 
            t.ID_ as task_id,
            t.NAME_ as task_name,
            t.TASK_DEF_KEY_,
            t.PROC_DEF_ID_,
            t.CREATE_TIME_ as task_create_time,
            t.ASSIGNEE_ as task_assignee,
            t.PRIORITY_,
            p.ID_ as proc_inst_id,
            p.BUSINESS_KEY_,
            p.START_TIME_,
            p.START_USER_ID_,
            p.PROC_DEF_ID_ as proc_def_id
        FROM ACT_HI_TASKINST t
        JOIN ACT_HI_PROCINST p ON t.PROC_INST_ID_ = p.ID_
        WHERE t.ID_ = ? AND t.PROC_INST_ID_ = ?
    `
    params = [targetTaskId, instanceId]
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/g, (_, i) => `$${i + 1}`)
    }
    
    let taskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(sql, params)
        taskRows = result
    } else {
        const result = await db.query(sql, params)
        taskRows = result.rows
    }
    
    if (taskRows.length === 0) {
        throw new Error('历史任务不存在')
    }
    
    const taskData = taskRows[0]
    
    // 2. 查询目标任务之后的所有历史记录，准备删除
    sql = `SELECT ID_, START_TIME_ FROM ACT_HI_TASKINST WHERE PROC_INST_ID_ = ? ORDER BY START_TIME_ ASC`
    if (dbType === 'postgres') {
        sql = sql.replace(/\?/, '$1')
    }
    
    let allTaskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(sql, [instanceId])
        allTaskRows = result
    } else {
        const result = await db.query(sql, [instanceId])
        allTaskRows = result.rows
    }
    
    // 找到目标任务的索引，收集之后要删除的任务ID
    let targetTaskIndex = -1
    const taskIdsToDelete = []
    for (let i = 0; i < allTaskRows.length; i++) {
        if (allTaskRows[i].ID_ === targetTaskId) {
            targetTaskIndex = i
        } else if (targetTaskIndex !== -1) {
            taskIdsToDelete.push(allTaskRows[i].ID_)
        }
    }
    
    if (dbType === 'mysql') {
        // 3. 恢复执行实例，使用从历史表获得的所有信息
        sql = `
            INSERT INTO ACT_RU_EXECUTION (
                ID_, REV_, PROC_INST_ID_, BUSINESS_KEY_, 
                PROC_DEF_ID_, IS_ACTIVE_, IS_SCOPE_,
                START_TIME_, START_USER_ID_
            ) VALUES (?, 1, ?, ?, ?, 1, 1, ?, ?)
        `
        await db.execute(sql, [instanceId, instanceId, taskData.BUSINESS_KEY_, taskData.PROC_DEF_ID_, taskData.START_TIME_, taskData.START_USER_ID_])
        
        // 4. 创建任务，使用原来的任务ID
        sql = `
            INSERT INTO ACT_RU_TASK (
                ID_, REV_, NAME_, PRIORITY_, 
                CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
            ) VALUES (?, 1, ?, ?, ?, NULL, ?, ?, ?, ?, 1)
        `
        await db.execute(sql, [
            targetTaskId, 
            taskData.task_name, 
            taskData.PRIORITY_ || 50, 
            taskData.task_create_time, 
            instanceId, 
            instanceId, 
            taskData.PROC_DEF_ID_, 
            taskData.TASK_DEF_KEY_
        ])
        
        // 5. 恢复身份关联
        sql = `
            SELECT TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
            FROM ACT_HI_IDENTITYLINK
            WHERE TASK_ID_ = ? OR PROC_INST_ID_ = ?
        `
        const [identityLinks] = await db.execute(sql, [targetTaskId, instanceId])
        
        for (const link of identityLinks) {
            const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            sql = `
                INSERT INTO ACT_RU_IDENTITYLINK (
                    ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                ) VALUES (?, 1, ?, ?, ?, ?, ?)
            `
            await db.execute(sql, [linkId, link.TYPE_, link.USER_ID_, link.GROUP_ID_, targetTaskId, instanceId])
        }
        
        // 6. 恢复变量
        sql = `
            SELECT NAME_, VAR_TYPE_, TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
            FROM ACT_HI_VARINST 
            WHERE PROC_INST_ID_ = ? 
              AND NAME_ IS NOT NULL
        `
        const [varRows] = await db.execute(sql, [instanceId])
        
        for (const v of varRows) {
            const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            const varType = v.VAR_TYPE_ || 'string'
            
            sql = `
                INSERT INTO ACT_RU_VARIABLE (
                    ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                    TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
            `
            await db.execute(sql, [
                varId, 
                v.NAME_, 
                varType, 
                instanceId, 
                v.TEXT_, 
                v.TEXT2_, 
                v.DOUBLE_, 
                v.LONG_, 
                v.BYTEARRAY_ID_
            ])
        }
        
        // 7. 删除目标任务之后的历史活动
        if (taskIdsToDelete.length > 0) {
            const placeholders = taskIdsToDelete.map(() => '?').join(',')
            sql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
            await db.execute(sql, taskIdsToDelete)
            
            // 8. 删除目标任务之后的历史任务
            sql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
            await db.execute(sql, taskIdsToDelete)
        }
        
        // 9. 删除活动历史
        sql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = ?`
        await db.execute(sql, [instanceId])
        
        // 10. 更新目标历史任务
        sql = `
            UPDATE ACT_HI_TASKINST 
            SET END_TIME_ = NULL, DELETE_REASON_ = NULL
            WHERE ID_ = ?
        `
        await db.execute(sql, [targetTaskId])
        
        // 11. 更新历史流程实例
        sql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = ?`
        await db.execute(sql, [instanceId])
    } else {
        // 瀚高/PostgreSQL 版本
        sql = `
            INSERT INTO ACT_RU_EXECUTION (
                ID_, REV_, PROC_INST_ID_, BUSINESS_KEY_, 
                PROC_DEF_ID_, IS_ACTIVE_, IS_SCOPE_,
                START_TIME_, START_USER_ID_
            ) VALUES ($1, 1, $2, $3, $4, 1, 1, $5, $6)
        `
        await db.query(sql, [instanceId, instanceId, taskData.BUSINESS_KEY_, taskData.PROC_DEF_ID_, taskData.START_TIME_, taskData.START_USER_ID_])
        
        sql = `
            INSERT INTO ACT_RU_TASK (
                ID_, REV_, NAME_, PRIORITY_, 
                CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
            ) VALUES ($1, 1, $2, $3, $4, NULL, $5, $6, $7, $8, 1)
        `
        await db.query(sql, [
            targetTaskId, 
            taskData.task_name, 
            taskData.PRIORITY_ || 50, 
            taskData.task_create_time, 
            instanceId, 
            instanceId, 
            taskData.PROC_DEF_ID_, 
            taskData.TASK_DEF_KEY_
        ])
        
        sql = `
            SELECT TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
            FROM ACT_HI_IDENTITYLINK
            WHERE TASK_ID_ = $1 OR PROC_INST_ID_ = $2
        `
        const identityResult = await db.query(sql, [targetTaskId, instanceId])
        
        for (const link of identityResult.rows) {
            const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            sql = `
                INSERT INTO ACT_RU_IDENTITYLINK (
                    ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                ) VALUES ($1, 1, $2, $3, $4, $5, $6)
            `
            await db.query(sql, [linkId, link.TYPE_, link.USER_ID_, link.GROUP_ID_, targetTaskId, instanceId])
        }
        
        sql = `
            SELECT NAME_, VAR_TYPE_, TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
            FROM ACT_HI_VARINST 
            WHERE PROC_INST_ID_ = $1 
              AND NAME_ IS NOT NULL
        `
        const varResult = await db.query(sql, [instanceId])
        
        for (const v of varResult.rows) {
            const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
            const varType = v.VAR_TYPE_ || 'string'
            
            sql = `
                INSERT INTO ACT_RU_VARIABLE (
                    ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                    TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
            `
            await db.query(sql, [
                varId, 
                v.NAME_, 
                varType, 
                instanceId, 
                v.TEXT_, 
                v.TEXT2_, 
                v.DOUBLE_, 
                v.LONG_, 
                v.BYTEARRAY_ID_
            ])
        }
        
        // 删除目标任务之后的历史
        if (taskIdsToDelete.length > 0) {
            const placeholders = taskIdsToDelete.map((_, i) => `$${i + 1}`).join(',')
            sql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
            await db.query(sql, taskIdsToDelete)
            
            sql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
            await db.query(sql, taskIdsToDelete)
        }
        
        sql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = $1`
        await db.query(sql, [instanceId])
        
        sql = `
            UPDATE ACT_HI_TASKINST 
            SET END_TIME_ = NULL, DELETE_REASON_ = NULL
            WHERE ID_ = $1
        `
        await db.query(sql, [targetTaskId])
        
        sql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = $1`
        await db.query(sql, [instanceId])
    }
}

async function setTaskAssignee(db, dbType, taskId, assignee) {
    let sql
    if (dbType === 'mysql') {
        sql = 'UPDATE ACT_RU_TASK SET ASSIGNEE_ = ?, REV_ = REV_ + 1 WHERE ID_ = ?'
        await db.execute(sql, [assignee, taskId])
    } else {
        sql = 'UPDATE ACT_RU_TASK SET ASSIGNEE_ = $1, REV_ = REV_ + 1 WHERE ID_ = $2'
        await db.query(sql, [assignee, taskId])
    }
}

async function addTaskIdentityLink(db, dbType, taskId, userId, type) {
    let idSql
    let sql
    let params
    
    if (dbType === 'mysql') {
        idSql = 'SELECT UUID() as id'
        sql = `
            INSERT INTO ACT_RU_IDENTITYLINK (ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_, PROC_DEF_ID_)
            VALUES (?, 1, ?, ?, NULL, ?, NULL, NULL)
        `
    } else {
        idSql = 'SELECT gen_random_uuid() as id'
        sql = `
            INSERT INTO ACT_RU_IDENTITYLINK (ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_, PROC_DEF_ID_)
            VALUES ($1, 1, $2, $3, NULL, $4, NULL, NULL)
        `
    }
    
    let idResult
    if (dbType === 'mysql') {
        const [rows] = await db.execute(idSql)
        idResult = rows[0].id
    } else {
        const result = await db.query(idSql)
        idResult = result.rows[0].id
    }
    
    params = [idResult, type, userId, taskId]
    
    if (dbType === 'mysql') {
        await db.execute(sql, params)
    } else {
        await db.query(sql, params)
    }
}

async function deleteTaskIdentityLink(db, dbType, taskId, userId, type) {
    let sql
    if (dbType === 'mysql') {
        if (userId && type) {
            sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ = ? AND USER_ID_ = ? AND TYPE_ = ?'
            await db.execute(sql, [taskId, userId, type])
        } else if (userId) {
            sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ = ? AND USER_ID_ = ?'
            await db.execute(sql, [taskId, userId])
        } else {
            sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ = ?'
            await db.execute(sql, [taskId])
        }
    } else {
        if (userId && type) {
            sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ = $1 AND USER_ID_ = $2 AND TYPE_ = $3'
            await db.query(sql, [taskId, userId, type])
        } else if (userId) {
            sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ = $1 AND USER_ID_ = $2'
            await db.query(sql, [taskId, userId])
        } else {
            sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ = $1'
            await db.query(sql, [taskId])
        }
    }
}

async function getTaskIdentityLinks(db, dbType, taskId) {
    let sql
    if (dbType === 'mysql') {
        sql = `
            SELECT il.ID_ as id, il.TYPE_ as type, il.USER_ID_ as userId, il.GROUP_ID_ as groupId,
                   su.username, su.realname
            FROM ACT_RU_IDENTITYLINK il
            LEFT JOIN sys_user su ON il.USER_ID_ = su.id
            WHERE il.TASK_ID_ = ? AND il.TYPE_ = 'candidate' AND il.USER_ID_ IS NOT NULL
        `
        const [rows] = await db.execute(sql, [taskId])
        return rows
    } else {
        sql = `
            SELECT il.ID_ as id, il.TYPE_ as type, il.USER_ID_ as userId, il.GROUP_ID_ as groupId,
                   su.username, su.realname
            FROM ACT_RU_IDENTITYLINK il
            LEFT JOIN sys_user su ON il.USER_ID_ = su.id
            WHERE il.TASK_ID_ = $1 AND il.TYPE_ = 'candidate' AND il.USER_ID_ IS NOT NULL
        `
        const result = await db.query(sql, [taskId])
        return result.rows
    }
}

async function deleteProcessInstance(db, dbType, instanceId) {
    let sql
    if (dbType === 'mysql') {
        sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_TASK WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_EXECUTION WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_JOB WHERE PROCESS_INSTANCE_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_EVENT_SUBSCR WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_IDENTITYLINK WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_TASKINST WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_VARINST WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_DETAIL WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_COMMENT WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_ATTACHMENT WHERE PROC_INST_ID_ = ?'
        await db.execute(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_PROCINST WHERE ID_ = ?'
        await db.execute(sql, [instanceId])
    } else {
        sql = 'DELETE FROM ACT_RU_IDENTITYLINK WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_TASK WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_EXECUTION WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_JOB WHERE PROCESS_INSTANCE_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_RU_EVENT_SUBSCR WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_IDENTITYLINK WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_TASKINST WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_VARINST WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_DETAIL WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_COMMENT WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_ATTACHMENT WHERE PROC_INST_ID_ = $1'
        await db.query(sql, [instanceId])
        
        sql = 'DELETE FROM ACT_HI_PROCINST WHERE ID_ = $1'
        await db.query(sql, [instanceId])
    }
}

// ========== 启动服务器 ==========

async function start() {
    await initLocalDb()
    
    app.listen(PORT, () => {
        console.log(`============================================`)
        console.log(`  Activiti Tools 已启动`)
        console.log(`  访问地址: http://localhost:${PORT}`)
        console.log(`  按 Ctrl+C 停止服务器`)
        console.log(`============================================`)
        openBrowser(`http://localhost:${PORT}`)
    })
}

process.on('SIGINT', () => {
    console.log('\n正在关闭服务器...')
    if (activitiDb) {
        if (dbConfig?.dbType === 'postgres') {
            activitiDb.end()
        } else if (activitiDb.end) {
            activitiDb.end()
        }
    }
    if (localDb) {
        saveLocalDb()
        localDb.close()
    }
    process.exit(0)
})

start()
