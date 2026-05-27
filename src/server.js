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

// 用户缓存 - 本次连接一直缓存
let cachedUsers = null

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
            password TEXT,
            schema TEXT
        )
    `)
    // 为现有表添加schema字段（如果不存在）
    try {
        localDb.run(`ALTER TABLE connections ADD COLUMN schema TEXT`)
    } catch (e) {
        // 字段可能已经存在，忽略错误
    }
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
        INSERT INTO connections (name, db_type, host, port, database, username, password, schema)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [config.name, config.dbType, config.host, config.port, config.database, config.username, config.password, config.schema])
    saveLocalDb()
    
    const result = localDb.exec('SELECT last_insert_rowid() as id')
    const id = result[0]?.values[0]?.[0] || 0
    res.json({ success: true, id })
})

app.get('/api/connections', (req, res) => {
    const result = localDb.exec('SELECT id, name, db_type, host, port, database, username, schema FROM connections')
    const connections = result.length > 0 ? result[0].values.map(row => ({
        id: row[0], name: row[1], db_type: row[2], host: row[3], port: row[4], database: row[5], username: row[6], schema: row[7]
    })) : []
    res.json(connections)
})

app.delete('/api/connections/:id', (req, res) => {
    localDb.run('DELETE FROM connections WHERE id = ?', [parseInt(req.params.id)])
    saveLocalDb()
    res.json({ success: true })
})

app.post('/api/test-basic-connection', async (req, res) => {
    const config = req.body
    let conn
    try {
        if (config.dbType === 'mysql') {
            conn = await mysql.createConnection({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password
            })
            await conn.ping()
            // 获取所有数据库
            const [rows] = await conn.execute('SHOW DATABASES')
            const databases = rows
                .map(row => Object.values(row)[0])
                .filter(db => !['information_schema', 'performance_schema', 'mysql', 'sys', 'test'].includes(db))
            
            res.json({ success: true, databases })
        } else if (config.dbType === 'postgres' || config.dbType === 'hgdatabase') {
            const poolConfig = {
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: 'postgres'
            }
            conn = new Pool(poolConfig)
            await conn.query('SELECT 1')
            
            // 获取所有数据库
            const dbResult = await conn.query(`
                SELECT datname 
                FROM pg_database 
                WHERE datistemplate = false 
                ORDER BY datname
            `)
            const databases = dbResult.rows.map(row => row.datname)
            
            res.json({ success: true, databases })
        }
    } catch (error) {
        res.json({ success: false, message: error.message })
    } finally {
        if (conn) {
            if (config.dbType === 'mysql') await conn.end()
            else await conn.end()
        }
    }
})

app.post('/api/get-schemas', async (req, res) => {
    const config = req.body
    let conn
    try {
        if (config.dbType === 'postgres' || config.dbType === 'hgdatabase') {
            const poolConfig = {
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database
            }
            conn = new Pool(poolConfig)
            await conn.query('SELECT 1')
            
            // 获取所有 schema
            const schemaResult = await conn.query(`
                SELECT schema_name 
                FROM information_schema.schemata 
                WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
                ORDER BY schema_name
            `)
            const schemas = schemaResult.rows.map(row => row.schema_name)
            
            res.json({ success: true, schemas })
        } else {
            res.json({ success: true, schemas: [] })
        }
    } catch (error) {
        res.json({ success: false, message: error.message })
    } finally {
        if (conn) {
            conn.end()
        }
    }
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
        if (dbConfig?.dbType === 'postgres' || dbConfig?.dbType === 'hgdatabase') {
            activitiDb.end()
        } else {
            activitiDb.end()
        }
    }
    activitiDb = null
    dbConfig = null
    cachedUsers = null
    cacheTimestamp = 0
    res.json({ success: true })
})

app.get('/api/connection-status', (req, res) => {
    res.json({ connected: !!activitiDb, config: dbConfig ? { ...dbConfig, password: undefined } : null })
})

app.get('/api/users', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const keyword = req.query.keyword || ''
        let users = await getUsers(dbType = dbConfig.dbType, keyword)
        res.json(users)
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
})

app.put('/api/history-tasks/:taskId/assignee', async (req, res) => {
    if (!activitiDb) {
        return res.status(400).json({ error: '未连接到数据库' })
    }
    
    try {
        const { assignee, endTime } = req.body
        await updateHistoryTaskAssignee(activitiDb, dbConfig.dbType, req.params.taskId, assignee, endTime)
        res.json({ success: true })
    } catch (error) {
        res.status(500).json({ error: error.message })
    }
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
            
            // 验证 Activiti 表是否存在
            const [tables] = await conn.execute(
                'SELECT TABLE_NAME FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?',
                [config.database, 'ACT_HI_PROCINST']
            )
            if (!tables || tables.length === 0) {
                throw new Error('连接成功，但未找到 Activiti 工作流相关表，请检查数据库名称是否正确')
            }
        } else if (config.dbType === 'postgres' || config.dbType === 'hgdatabase') {
            const poolConfig = {
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.database
            }
            if (config.schema) {
                poolConfig.options = `-c search_path=${config.schema}`
            }
            conn = new Pool(poolConfig)
            await conn.query('SELECT 1')
            
            // 验证 Activiti 表是否存在
            const tableCheckQuery = config.schema 
                ? `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_schema = $1 AND table_name = 'act_hi_procinst')`
                : `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'act_hi_procinst')`
            
            const params = config.schema ? [config.schema] : []
            const result = await conn.query(tableCheckQuery, params)
            
            const tableExists = result.rows && result.rows[0] && Object.values(result.rows[0])[0]
            
            if (!tableExists) {
                if (config.schema) {
                    throw new Error(`连接成功，但在 schema "${config.schema}" 中未找到 Activiti 工作流相关表，请检查 schema 名称是否正确`)
                } else {
                    throw new Error('连接成功，但未找到 Activiti 工作流相关表，请检查数据库名称是否正确，或填写正确的 schema 名称')
                }
            }
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
    } else if (config.dbType === 'postgres' || config.dbType === 'hgdatabase') {
        const poolConfig = {
            host: config.host,
            port: config.port,
            user: config.username,
            password: config.password,
            database: config.database
        }
        if (config.schema) {
            poolConfig.options = `-c search_path=${config.schema}`
        }
        return new Pool(poolConfig)
    }
}

// 将字段名转换为驼峰命名法
function toCamelCase(str) {
    if (!str) return str
    return str.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

// 转换对象的所有字段名为驼峰命名法
function convertToCamelCase(obj) {
    if (Array.isArray(obj)) {
        return obj.map(item => convertToCamelCase(item))
    } else if (obj && typeof obj === 'object' && !(obj instanceof Date) && !(obj instanceof Buffer) && !(obj instanceof Uint8Array)) {
        const result = {}
        for (const key in obj) {
            const camelKey = toCamelCase(key)
            let value = obj[key]
            if (value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof Buffer) && !(value instanceof Uint8Array)) {
                value = convertToCamelCase(value)
            }
            result[camelKey] = value
        }
        return result
    }
    return obj
}

// 给PostgreSQL/瀚高数据库的SQL中的所有标识符加双引号（保持大小写）
function quotePostgresIdentifiers(sql) {
    // 只给别名加双引号（驼峰命名）
    sql = sql.replace(/\bas\s+([a-z][a-zA-Z0-9]*)/gi, 'AS "$1"')
    return sql
}

async function query(db, dbType, sql, params = []) {
    let rows
    if (dbType === 'mysql') {
        [rows] = await db.execute(sql, params)
    } else {
        // 转换 ? 占位符为 $1, $2, $3...
        let pgSql = sql
        let paramIndex = 1
        pgSql = pgSql.replace(/\?/g, () => "$" + paramIndex++)

        try {
            const quotedSql = quotePostgresIdentifiers(pgSql)
            const result = await db.query(quotedSql, params)
            rows = result.rows
        } catch (err) {
            console.error('[SQL ERROR]', err.message)
            console.error('[SQL QUERY]', pgSql)
            throw err
        }
    }
    return convertToCamelCase(rows)
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
        const rows = await query(db, dbType, countSql, countParams)
        total = parseInt(rows[0]?.total || 0)
    }
    
    if (dbType === 'mysql') {
        sql += ' LIMIT ? OFFSET ?'
        params.push(size, offset)
    } else {
        sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
        params.push(size, offset)
    }
    
    const instances = await query(db, dbType, sql, params)
    
    for (const inst of instances) {
        let taskSql = `
            SELECT t.ID_ as id, t.NAME_ as name, t.ASSIGNEE_ as assignee, t.CREATE_TIME_ as createTime,
                   su.username as assigneeName, su.realname as assigneeRealname
            FROM ACT_RU_TASK t
            LEFT JOIN sys_user su ON t.ASSIGNEE_ = su.id
            WHERE t.PROC_INST_ID_ = ?
        `
        const taskRows = await query(db, dbType, taskSql, [inst.id])
        inst.currentTasks = taskRows
        
        inst.isFinished = inst.currentTasks.length === 0
        
        if (!inst.isFinished) {
            let historySql = `
                SELECT END_TIME_ as endTime 
                FROM ACT_HI_PROCINST 
                WHERE PROC_INST_ID_ = ?
            `
            const historyRows = await query(db, dbType, historySql, [inst.id])
            inst.isFinished = historyRows.length > 0 && historyRows[0].endTime !== null
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
    
    const rows = await query(db, dbType, sql, [instanceId])
    instance = rows[0]
    
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
        const historyRows = await query(db, dbType, historySql, [instanceId])
        instance = historyRows[0]
        
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
        
        const taskRows = await query(db, dbType, taskSql, [instanceId])
        
        for (const row of taskRows) {
            row.candidates = []
        }
        
        if (taskRows.length > 0) {
            const taskIds = taskRows.map(r => r.id)
            const placeholders = dbType === 'mysql' 
                ? taskIds.map(() => '?').join(',')
                : taskIds.map((_, i) => `$${i + 1}`).join(',')
            
            let candidateSql = `
                SELECT il.TASK_ID_ as taskId, il.USER_ID_ as userId, su.username, su.realname
                FROM ACT_RU_IDENTITYLINK il
                LEFT JOIN sys_user su ON il.USER_ID_ = su.id
                WHERE il.TASK_ID_ IN (${placeholders}) AND il.TYPE_ = 'candidate' AND il.USER_ID_ IS NOT NULL
            `
            
            const candidates = await query(db, dbType, candidateSql, taskIds)
            
            const candidateMap = {}
            for (const c of candidates) {
                if (!candidateMap[c.taskId]) {
                    candidateMap[c.taskId] = []
                }
                candidateMap[c.taskId].push(c)
            }
            
            for (const row of taskRows) {
                row.candidates = candidateMap[row.id] || []
            }
        }
        
        instance.currentTasks = taskRows
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
        const rows = await query(db, dbType, countSql, countParams)
        total = parseInt(rows[0]?.total || 0)
    }
    
    if (dbType === 'mysql') {
        sql += ' LIMIT ? OFFSET ?'
        params.push(size, offset)
    } else {
        sql += ` LIMIT $${params.length + 1} OFFSET $${params.length + 2}`
        params.push(size, offset)
    }
    
    const instances = await query(db, dbType, sql, params)
    
    for (const inst of instances) {
        inst.isFinished = true
    }
    
    return { instances, total }
}

async function getProcessVariables(db, dbType, instanceId) {
    let sql
    if (dbType === 'mysql') {
        sql = `
            SELECT NAME_ as name, TYPE_ as \`type\`, TEXT_ as textValue, DOUBLE_ as \`double\`, LONG_ as \`long\`, BYTEARRAY_ID_ as bytearrayId
            FROM ACT_RU_VARIABLE
            WHERE PROC_INST_ID_ = ?
        `
    } else {
        sql = `
            SELECT NAME_ as name, TYPE_ as "type", TEXT_ as textValue, DOUBLE_ as "double", LONG_ as "long", BYTEARRAY_ID_ as bytearrayId
            FROM ACT_RU_VARIABLE
            WHERE PROC_INST_ID_ = $1
        `
    }
    
    const rows = await query(db, dbType, sql, [instanceId])
    
    return rows.map(v => {
        let value
        switch (v.type) {
            case 'string': 
                value = v.textValue; 
                break
            case 'long': 
                value = v.long; 
                break
            case 'double': 
                value = v.double; 
                break
            case 'boolean':
                // boolean 通常也存储在 text_ 字段或 long_ 字段
                value = v.textValue !== null ? v.textValue : (v.long !== null ? !!v.long : null);
                break
            default: 
                // 对于其他类型（包括 bytearray）显示占位符
                value = v.bytearrayId !== null ? '[byteArray]' : v.textValue;
        }
        return { name: v.name, type: v.type, value }
    })
}

async function setProcessVariable(db, dbType, instanceId, variable) {
    // 首先检查变量是否存在
    let checkSql, checkParams
    
    // 先查询现有变量的详细信息，包括类型
    let selectSql, selectParams
    if (dbType === 'mysql') {
        selectSql = 'SELECT ID_, TYPE_ FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = ? AND NAME_ = ?'
        selectParams = [instanceId, variable.name]
        const [selectResult] = await db.execute(selectSql, selectParams)
        const variableExists = selectResult.length > 0
        
        // 如果是 bytearray 类型，不允许修改
        if (variableExists && selectResult[0].TYPE_ && 
            (selectResult[0].TYPE_.toLowerCase().includes('byte') || selectResult[0].TYPE_.toLowerCase() === 'serializable')) {
            throw new Error('Bytearray 类型变量不允许修改')
        }
        
        // 根据变量类型设置值，只设置对应字段
        let setFields = [], setParams = []
        setParams.push(variable.type) // 首先设置类型
        
        switch (variable.type) {
            case 'string':
                setFields.push('TEXT_ = ?')
                setParams.push(variable.value)
                break
            case 'long':
                setFields.push('LONG_ = ?')
                setParams.push(parseInt(variable.value))
                break
            case 'double':
                setFields.push('DOUBLE_ = ?')
                setParams.push(parseFloat(variable.value))
                break
            case 'boolean':
                setFields.push('TEXT_ = ?')
                setParams.push(variable.value ? 'true' : 'false')
                break
            default:
                // 默认按字符串处理
                setFields.push('TEXT_ = ?')
                setParams.push(String(variable.value))
        }
        
        // 添加 WHERE 条件参数
        setParams.push(instanceId)
        setParams.push(variable.name)
        
        if (variableExists) {
            // 更新已存在的变量
            const updateRuSql = `UPDATE ACT_RU_VARIABLE SET TYPE_ = ?, ${setFields.join(', ')} WHERE PROC_INST_ID_ = ? AND NAME_ = ?`
            await db.execute(updateRuSql, setParams)
            
            const updateHiSql = `UPDATE ACT_HI_VARINST SET VAR_TYPE_ = ?, ${setFields.join(', ').replace(/TEXT_/g, 'TEXT_').replace(/DOUBLE_/g, 'DOUBLE_').replace(/LONG_/g, 'LONG_')} WHERE PROC_INST_ID_ = ? AND NAME_ = ?`
            await db.execute(updateHiSql, setParams)
        } else {
            // 插入新变量
            // 准备 insert 字段和值
            let insertFields = ['ID_', 'REV_', 'NAME_', 'TYPE_', 'PROC_INST_ID_']
            let insertValues = ['UUID()', '?', '?', '?', '?']
            let insertParams = [variable.name, variable.type, instanceId]
            
            switch (variable.type) {
                case 'string':
                    insertFields.push('TEXT_')
                    insertValues.push('?')
                    insertParams.push(variable.value)
                    break
                case 'long':
                    insertFields.push('LONG_')
                    insertValues.push('?')
                    insertParams.push(parseInt(variable.value))
                    break
                case 'double':
                    insertFields.push('DOUBLE_')
                    insertValues.push('?')
                    insertParams.push(parseFloat(variable.value))
                    break
                case 'boolean':
                    insertFields.push('TEXT_')
                    insertValues.push('?')
                    insertParams.push(variable.value ? 'true' : 'false')
                    break
                default:
                    insertFields.push('TEXT_')
                    insertValues.push('?')
                    insertParams.push(String(variable.value))
            }
            
            const insertRuSql = `INSERT INTO ACT_RU_VARIABLE (${insertFields.join(', ')}) VALUES (${insertValues.join(', ')})`
            await db.execute(insertRuSql, [''].concat(insertParams).slice(1)) // 跳过 UUID() 的占位符
            
            // 历史表插入
            let hiInsertFields = ['ID_', 'NAME_', 'VAR_TYPE_', 'PROC_INST_ID_']
            let hiInsertValues = ['UUID()', '?', '?', '?']
            let hiInsertParams = [variable.name, variable.type, instanceId]
            
            switch (variable.type) {
                case 'string':
                    hiInsertFields.push('TEXT_')
                    hiInsertValues.push('?')
                    hiInsertParams.push(variable.value)
                    break
                case 'long':
                    hiInsertFields.push('LONG_')
                    hiInsertValues.push('?')
                    hiInsertParams.push(parseInt(variable.value))
                    break
                case 'double':
                    hiInsertFields.push('DOUBLE_')
                    hiInsertValues.push('?')
                    hiInsertParams.push(parseFloat(variable.value))
                    break
                case 'boolean':
                    hiInsertFields.push('TEXT_')
                    hiInsertValues.push('?')
                    hiInsertParams.push(variable.value ? 'true' : 'false')
                    break
                default:
                    hiInsertFields.push('TEXT_')
                    hiInsertValues.push('?')
                    hiInsertParams.push(String(variable.value))
            }
            
            const insertHiSql = `INSERT INTO ACT_HI_VARINST (${hiInsertFields.join(', ')}) VALUES (${hiInsertValues.join(', ')})`
            await db.execute(insertHiSql, [''].concat(hiInsertParams).slice(1)) // 跳过 UUID() 的占位符
        }
    } else {
        selectSql = 'SELECT ID_, TYPE_ FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = $1 AND NAME_ = $2'
        selectParams = [instanceId, variable.name]
        const selectResult = await db.query(selectSql, selectParams)
        const variableExists = selectResult.rows.length > 0
        
        // 如果是 bytearray 类型，不允许修改
        if (variableExists && selectResult.rows[0].TYPE_ && 
            (selectResult.rows[0].TYPE_.toLowerCase().includes('byte') || selectResult.rows[0].TYPE_.toLowerCase() === 'serializable')) {
            throw new Error('Bytearray 类型变量不允许修改')
        }
        
        // 根据变量类型设置值，只设置对应字段
        let setFields = [], setParams = []
        let paramIndex = 1
        setParams.push(variable.type) // 首先设置类型
        paramIndex++
        
        switch (variable.type) {
            case 'string':
                setFields.push(`TEXT_ = $${paramIndex++}`)
                setParams.push(variable.value)
                break
            case 'long':
                setFields.push(`LONG_ = $${paramIndex++}`)
                setParams.push(parseInt(variable.value))
                break
            case 'double':
                setFields.push(`DOUBLE_ = $${paramIndex++}`)
                setParams.push(parseFloat(variable.value))
                break
            case 'boolean':
                setFields.push(`TEXT_ = $${paramIndex++}`)
                setParams.push(variable.value ? 'true' : 'false')
                break
            default:
                // 默认按字符串处理
                setFields.push(`TEXT_ = $${paramIndex++}`)
                setParams.push(String(variable.value))
        }
        
        // 添加 WHERE 条件参数
        const whereProcIdParam = `$${paramIndex++}`
        const whereNameParam = `$${paramIndex++}`
        setParams.push(instanceId)
        setParams.push(variable.name)
        
        if (variableExists) {
            // 更新已存在的变量
            const updateRuSql = `UPDATE ACT_RU_VARIABLE SET TYPE_ = $1, ${setFields.join(', ')} WHERE PROC_INST_ID_ = ${whereProcIdParam} AND NAME_ = ${whereNameParam}`
            await db.query(updateRuSql, setParams)
            
            const updateHiSql = `UPDATE ACT_HI_VARINST SET VAR_TYPE_ = $1, ${setFields.join(', ')} WHERE PROC_INST_ID_ = ${whereProcIdParam} AND NAME_ = ${whereNameParam}`
            await db.query(updateHiSql, setParams)
        } else {
            // 插入新变量
            // 准备 insert 字段和值
            let insertFields = ['ID_', 'REV_', 'NAME_', 'TYPE_', 'PROC_INST_ID_']
            let insertValues = ['gen_random_uuid()', '1', '$1', '$2', '$3']
            let insertParams = [variable.name, variable.type, instanceId]
            let insertParamIndex = 4
            
            switch (variable.type) {
                case 'string':
                    insertFields.push('TEXT_')
                    insertValues.push(`$${insertParamIndex++}`)
                    insertParams.push(variable.value)
                    break
                case 'long':
                    insertFields.push('LONG_')
                    insertValues.push(`$${insertParamIndex++}`)
                    insertParams.push(parseInt(variable.value))
                    break
                case 'double':
                    insertFields.push('DOUBLE_')
                    insertValues.push(`$${insertParamIndex++}`)
                    insertParams.push(parseFloat(variable.value))
                    break
                case 'boolean':
                    insertFields.push('TEXT_')
                    insertValues.push(`$${insertParamIndex++}`)
                    insertParams.push(variable.value ? 'true' : 'false')
                    break
                default:
                    insertFields.push('TEXT_')
                    insertValues.push(`$${insertParamIndex++}`)
                    insertParams.push(String(variable.value))
            }
            
            const insertRuSql = `INSERT INTO ACT_RU_VARIABLE (${insertFields.join(', ')}) VALUES (${insertValues.join(', ')})`
            await db.query(insertRuSql, insertParams)
            
            // 历史表插入
            let hiInsertFields = ['ID_', 'NAME_', 'VAR_TYPE_', 'PROC_INST_ID_']
            let hiInsertValues = ['gen_random_uuid()', '$1', '$2', '$3']
            let hiInsertParams = [variable.name, variable.type, instanceId]
            let hiInsertParamIndex = 4
            
            switch (variable.type) {
                case 'string':
                    hiInsertFields.push('TEXT_')
                    hiInsertValues.push(`$${hiInsertParamIndex++}`)
                    hiInsertParams.push(variable.value)
                    break
                case 'long':
                    hiInsertFields.push('LONG_')
                    hiInsertValues.push(`$${hiInsertParamIndex++}`)
                    hiInsertParams.push(parseInt(variable.value))
                    break
                case 'double':
                    hiInsertFields.push('DOUBLE_')
                    hiInsertValues.push(`$${hiInsertParamIndex++}`)
                    hiInsertParams.push(parseFloat(variable.value))
                    break
                case 'boolean':
                    hiInsertFields.push('TEXT_')
                    hiInsertValues.push(`$${hiInsertParamIndex++}`)
                    hiInsertParams.push(variable.value ? 'true' : 'false')
                    break
                default:
                    hiInsertFields.push('TEXT_')
                    hiInsertValues.push(`$${hiInsertParamIndex++}`)
                    hiInsertParams.push(String(variable.value))
            }
            
            const insertHiSql = `INSERT INTO ACT_HI_VARINST (${hiInsertFields.join(', ')}) VALUES (${hiInsertValues.join(', ')})`
            await db.query(insertHiSql, hiInsertParams)
        }
    }
}

async function deleteProcessVariable(db, dbType, instanceId, name) {
    // 删除运行时变量
    let sql = 'DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = ? AND NAME_ = ?'
    await query(db, dbType, sql, [instanceId, name])
    
    // 删除历史变量
    let hiSql = 'DELETE FROM ACT_HI_VARINST WHERE PROC_INST_ID_ = ? AND NAME_ = ?'
    await query(db, dbType, hiSql, [instanceId, name])
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
            SELECT ID_ as id, KEY_ as "key", NAME_ as name, VERSION_ as version, RESOURCE_NAME_ as resourceName
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
    
    const rows = await query(db, dbType, sql, [definitionId])
    
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
    
    const rows = await query(db, dbType, sql, [definitionId])
    
    if (rows.length === 0) {
        throw new Error('流程定义或BPMN文件不存在')
    }
    
    const byteArrayId = rows[0].byteArrayId
    const bytes = Buffer.from(xml, 'utf8')
    
    let updateSql
    if (dbType === 'mysql') {
        updateSql = 'UPDATE ACT_GE_BYTEARRAY SET BYTES_ = ? WHERE ID_ = ?'
        await db.execute(updateSql, [bytes, byteArrayId])
    } else {
        updateSql = 'UPDATE ACT_GE_BYTEARRAY SET BYTES_ = $1 WHERE ID_ = $2'
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
    
    const rows = await query(db, dbType, sql, [definitionId])
    
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
    // 1. 查询历史任务数据
    let taskSql = `
        SELECT 
            t.ID_ as taskId,
            t.NAME_ as taskName,
            t.TASK_DEF_KEY_ as taskDefKey,
            t.PROC_DEF_ID_ as procDefId,
            t.START_TIME_ as taskCreateTime,
            t.ASSIGNEE_ as taskAssignee,
            t.PRIORITY_ as priority,
            p.ID_ as procInstId,
            p.BUSINESS_KEY_ as businessKey,
            p.START_TIME_ as startTime,
            p.START_USER_ID_ as startUserId
        FROM ACT_HI_TASKINST t
        JOIN ACT_HI_PROCINST p ON t.PROC_INST_ID_ = p.ID_
        WHERE t.ID_ = ? AND t.PROC_INST_ID_ = ?
    `
    const taskParams = [targetTaskId, instanceId]
    
    let taskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(taskSql, taskParams)
        taskRows = result
    } else {
        // 转换占位符
        let pgTaskSql = taskSql
        let paramIndex = 1
        pgTaskSql = pgTaskSql.replace(/\?/g, () => `$${paramIndex++}`)
        taskRows = await query(db, dbType, pgTaskSql, taskParams)
    }
    
    if (taskRows.length === 0) {
        throw new Error('历史任务不存在')
    }
    
    const taskData = taskRows[0]
    
    // 2. 查询目标任务之后的所有历史记录，准备删除
    let allTaskSql = `SELECT ID_ as id, START_TIME_ as startTime FROM ACT_HI_TASKINST WHERE PROC_INST_ID_ = ? ORDER BY START_TIME_ ASC`
    let allTaskParams = [instanceId]
    
    let allTaskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(allTaskSql, allTaskParams)
        allTaskRows = result
    } else {
        let pgAllTaskSql = allTaskSql.replace(/\?/, '$1')
        allTaskRows = await query(db, dbType, pgAllTaskSql, allTaskParams)
    }
    
    // 找到目标任务的索引，收集之后要删除的任务ID
    let targetTaskIndex = -1
    const taskIdsToDelete = []
    for (let i = 0; i < allTaskRows.length; i++) {
        if (allTaskRows[i].id === targetTaskId) {
            targetTaskIndex = i
        } else if (targetTaskIndex !== -1) {
            taskIdsToDelete.push(allTaskRows[i].id)
        }
    }
    
    if (dbType === 'mysql') {
        // 开启事务
        await db.beginTransaction()
        try {
            // 3. 删除当前运行时的任务、变量、身份关联
            await db.execute('DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ IN (SELECT ID_ FROM ACT_RU_TASK WHERE PROC_INST_ID_ = ?)', [instanceId])
            await db.execute('DELETE FROM ACT_RU_TASK WHERE PROC_INST_ID_ = ?', [instanceId])
            await db.execute('DELETE FROM ACT_RU_EXECUTION WHERE PROC_INST_ID_ = ? AND PARENT_ID_ IS NOT NULL', [instanceId])
            await db.execute('DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = ?', [instanceId])
            
            // 4. 更新执行实例状态，保持开始时间和发起人
            const updateExecSql = `
                UPDATE ACT_RU_EXECUTION 
                SET IS_ACTIVE_ = 1, IS_SCOPE_ = 1,
                    START_TIME_ = ?, START_USER_ID_ = ?
                WHERE ID_ = ?
            `
            await db.execute(updateExecSql, [taskData.startTime, taskData.startUserId, instanceId])
            
            // 5. 查询身份关联（候选人）
            const identitySql = `
                SELECT TYPE_ as \`type\`, USER_ID_ as userId, GROUP_ID_ as groupId, TASK_ID_ as taskId, PROC_INST_ID_ as procInstId
                FROM ACT_HI_IDENTITYLINK
                WHERE TASK_ID_ = ? AND TYPE_ = 'candidate'
            `
            const [identityLinks] = await db.execute(identitySql, [targetTaskId])
            
            // 6. 确定任务审批人：如果没有候选人，使用历史任务的审批人
            let taskAssignee = null
            if (identityLinks.length === 0) {
                taskAssignee = taskData.taskAssignee
            }
            
            // 7. 创建任务，使用原来的任务ID
            const insertTaskSql = `
                INSERT INTO ACT_RU_TASK (
                    ID_, REV_, NAME_, PRIORITY_, 
                    CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                    PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `
            await db.execute(insertTaskSql, [
                targetTaskId, 
                taskData.taskName, 
                taskData.priority || 50, 
                taskData.taskCreateTime, 
                taskAssignee,
                instanceId, 
                instanceId, 
                taskData.procDefId, 
                taskData.taskDefKey
            ])
            
            // 8. 恢复身份关联（仅当有候选人时）
            for (const link of identityLinks) {
                const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const insertLinkSql = `
                    INSERT INTO ACT_RU_IDENTITYLINK (
                        ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                    ) VALUES (?, 1, ?, ?, ?, ?, ?)
                `
                await db.execute(insertLinkSql, [linkId, link.type, link.userId, link.groupId, targetTaskId, instanceId])
            }
            
            // 9. 恢复变量
            const selectVarSql = `
                SELECT NAME_ as name, VAR_TYPE_ as varType, TEXT_ as \`text\`, TEXT2_ as text2, DOUBLE_ as \`double\`, LONG_ as \`long\`, BYTEARRAY_ID_ as bytearrayId
                FROM ACT_HI_VARINST
                WHERE PROC_INST_ID_ = ? 
                  AND NAME_ IS NOT NULL
            `
            const [varRows] = await db.execute(selectVarSql, [instanceId])
            
            for (const v of varRows) {
                const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const varType = v.varType || 'string'
                
                const insertVarSql = `
                    INSERT INTO ACT_RU_VARIABLE (
                        ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                        TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
                `
                await db.execute(insertVarSql, [
                    varId, 
                    v.name, 
                    varType, 
                    instanceId, 
                    v.text, 
                    v.text2, 
                    v.double, 
                    v.long, 
                    v.bytearrayId
                ])
            }
            
            // 10. 删除目标任务之后的历史活动
            if (taskIdsToDelete.length > 0) {
                const placeholders = taskIdsToDelete.map(() => '?').join(',')
                
                // 10.1 删除历史评论
                await db.execute(`DELETE FROM ACT_HI_COMMENT WHERE TASK_ID_ IN (${placeholders})`, taskIdsToDelete)
                
                // 10.2 删除历史身份关联（包括candidate类型）
                await db.execute(`DELETE FROM ACT_HI_IDENTITYLINK WHERE TASK_ID_ IN (${placeholders})`, taskIdsToDelete)
                
                // 10.3 删除历史活动
                const delActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
                await db.execute(delActInstSql, taskIdsToDelete)
                
                // 10.4 删除目标任务之后的历史任务
                const delTaskInstSql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
                await db.execute(delTaskInstSql, taskIdsToDelete)
            }
            
            // 11. 删除活动历史
            const delAllActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = ?`
            await db.execute(delAllActInstSql, [instanceId])
            
            // 12. 更新目标历史任务，清除结束时间和审批人
            const updateTaskSql = `
                UPDATE ACT_HI_TASKINST 
                SET END_TIME_ = NULL, DELETE_REASON_ = NULL, ASSIGNEE_ = NULL
                WHERE ID_ = ?
            `
            await db.execute(updateTaskSql, [targetTaskId])
            
            // 14. 更新历史流程实例
            const updateProcInstSql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = ?`
            await db.execute(updateProcInstSql, [instanceId])
            
            // 提交事务
            await db.commit()
        } catch (error) {
            // 回滚事务
            await db.rollback()
            throw error
        }
    } else {
        // 瀚高/PostgreSQL 版本
        const client = await db.connect()
        try {
            await client.query('BEGIN')
            
            await client.query('DELETE FROM ACT_RU_IDENTITYLINK WHERE TASK_ID_ IN (SELECT ID_ FROM ACT_RU_TASK WHERE PROC_INST_ID_ = $1)', [instanceId])
            await client.query('DELETE FROM ACT_RU_TASK WHERE PROC_INST_ID_ = $1', [instanceId])
            await client.query('DELETE FROM ACT_RU_EXECUTION WHERE PROC_INST_ID_ = $1 AND PARENT_ID_ IS NOT NULL', [instanceId])
            await client.query('DELETE FROM ACT_RU_VARIABLE WHERE PROC_INST_ID_ = $1', [instanceId])
            
            const pgUpdateExecSql = `
                UPDATE ACT_RU_EXECUTION 
                SET IS_ACTIVE_ = true, IS_SCOPE_ = true,
                    START_TIME_ = $1, START_USER_ID_ = $2
                WHERE ID_ = $3
            `
            await client.query(pgUpdateExecSql, [taskData.startTime, taskData.startUserId, instanceId])
            
            // 查询身份关联（候选人）
            const pgIdentitySql = `
                SELECT TYPE_ as "type", USER_ID_ as userId, GROUP_ID_ as groupId, TASK_ID_ as taskId, PROC_INST_ID_ as procInstId
                FROM ACT_HI_IDENTITYLINK
                WHERE TASK_ID_ = $1 AND TYPE_ = 'candidate'
            `
            const identityResult = await client.query(pgIdentitySql, [targetTaskId])
            const identityLinks = identityResult.rows
            
            // 确定任务审批人：如果没有候选人，使用历史任务的审批人
            let taskAssignee = null
            if (identityLinks.length === 0) {
                taskAssignee = taskData.taskAssignee
            }
            
            // 创建任务，使用原来的任务ID
            const pgInsertTaskSql = `
                INSERT INTO ACT_RU_TASK (
                    ID_, REV_, NAME_, PRIORITY_, 
                    CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                    PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
                ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
            `
            await client.query(pgInsertTaskSql, [
                targetTaskId, 
                taskData.taskName, 
                taskData.priority || 50, 
                taskData.taskCreateTime, 
                taskAssignee,
                instanceId, 
                instanceId, 
                taskData.procDefId, 
                taskData.taskDefKey
            ])
            
            // 恢复身份关联（仅当有候选人时）
            for (const link of identityLinks) {
                const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const pgInsertLinkSql = `
                    INSERT INTO ACT_RU_IDENTITYLINK (
                        ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                    ) VALUES ($1, 1, $2, $3, $4, $5, $6)
                `
                await client.query(pgInsertLinkSql, [linkId, link.type, link.userId, link.groupId, targetTaskId, instanceId])
            }
            
            const pgSelectVarSql = `
                SELECT NAME_ as name, VAR_TYPE_ as varType, TEXT_ as "text", TEXT2_ as text2, DOUBLE_ as "double", LONG_ as "long", BYTEARRAY_ID_ as bytearrayId
                FROM ACT_HI_VARINST
                WHERE PROC_INST_ID_ = $1
                  AND NAME_ IS NOT NULL
            `
            const varResult = await client.query(pgSelectVarSql, [instanceId])
            const varRows = varResult.rows
            
            for (const v of varRows) {
                const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const varType = v.varType || 'string'
                
                const pgInsertVarSql = `
                    INSERT INTO ACT_RU_VARIABLE (
                        ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                        TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                    ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
                `
                await client.query(pgInsertVarSql, [
                    varId, 
                    v.name, 
                    varType, 
                    instanceId, 
                    v.text, 
                    v.text2, 
                    v.double, 
                    v.long, 
                    v.bytearrayId
                ])
            }
            
            // 9. 删除目标任务之后的历史
            if (taskIdsToDelete.length > 0) {
                const placeholders = taskIdsToDelete.map((_, i) => `$${i + 1}`).join(',')
                
                // 9.1 删除历史评论
                const pgDelCommentSql = `DELETE FROM ACT_HI_COMMENT WHERE TASK_ID_ IN (${placeholders})`
                await client.query(pgDelCommentSql, taskIdsToDelete)
                
                // 9.2 删除历史身份关联（包括candidate类型）
                const pgDelIdentitySql = `DELETE FROM ACT_HI_IDENTITYLINK WHERE TASK_ID_ IN (${placeholders})`
                await client.query(pgDelIdentitySql, taskIdsToDelete)
                
                // 9.3 删除历史活动
                const pgDelActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
                await client.query(pgDelActInstSql, taskIdsToDelete)
                
                // 9.4 删除目标任务之后的历史任务
                const pgDelTaskInstSql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
                await client.query(pgDelTaskInstSql, taskIdsToDelete)
            }
            
            const pgDelAllActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = $1`
            await client.query(pgDelAllActInstSql, [instanceId])
            
            // 10. 更新目标历史任务，清除结束时间和审批人
            const pgUpdateTaskSql = `
                UPDATE ACT_HI_TASKINST 
                SET END_TIME_ = NULL, DELETE_REASON_ = NULL, ASSIGNEE_ = NULL
                WHERE ID_ = $1
            `
            await client.query(pgUpdateTaskSql, [targetTaskId])
            
            const pgUpdateProcInstSql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = $1`
            await client.query(pgUpdateProcInstSql, [instanceId])
            
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
    }
}

async function jumpToFinishedHistoryTask(db, dbType, instanceId, targetTaskId) {
    // 1. 查询历史任务数据
    let taskSql = `
        SELECT 
            t.ID_ as taskId,
            t.NAME_ as taskName,
            t.TASK_DEF_KEY_ as taskDefKey,
            t.PROC_DEF_ID_ as procDefId,
            t.START_TIME_ as taskCreateTime,
            t.ASSIGNEE_ as taskAssignee,
            t.PRIORITY_ as priority,
            p.ID_ as procInstId,
            p.BUSINESS_KEY_ as businessKey,
            p.START_TIME_ as startTime,
            p.START_USER_ID_ as startUserId
        FROM ACT_HI_TASKINST t
        JOIN ACT_HI_PROCINST p ON t.PROC_INST_ID_ = p.ID_
        WHERE t.ID_ = ? AND t.PROC_INST_ID_ = ?
    `
    const taskParams = [targetTaskId, instanceId]
    
    let taskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(taskSql, taskParams)
        taskRows = result
    } else {
        // 转换占位符
        let pgTaskSql = taskSql
        let paramIndex = 1
        pgTaskSql = pgTaskSql.replace(/\?/g, () => `$${paramIndex++}`)
        taskRows = await query(db, dbType, pgTaskSql, taskParams)
    }
    
    if (taskRows.length === 0) {
        throw new Error('历史任务不存在')
    }
    
    const taskData = taskRows[0]
    
    // 2. 查询目标任务之后的所有历史记录，准备删除
    let allTaskSql = `SELECT ID_ as id, START_TIME_ as startTime FROM ACT_HI_TASKINST WHERE PROC_INST_ID_ = ? ORDER BY START_TIME_ ASC`
    let allTaskParams = [instanceId]
    
    let allTaskRows
    if (dbType === 'mysql') {
        const [result] = await db.execute(allTaskSql, allTaskParams)
        allTaskRows = result
    } else {
        let pgAllTaskSql = allTaskSql.replace(/\?/, '$1')
        allTaskRows = await query(db, dbType, pgAllTaskSql, allTaskParams)
    }
    
    // 找到目标任务的索引，收集之后要删除的任务ID
    let targetTaskIndex = -1
    const taskIdsToDelete = []
    for (let i = 0; i < allTaskRows.length; i++) {
        if (allTaskRows[i].id === targetTaskId) {
            targetTaskIndex = i
        } else if (targetTaskIndex !== -1) {
            taskIdsToDelete.push(allTaskRows[i].id)
        }
    }
    
    if (dbType === 'mysql') {
        // 开启事务
        await db.beginTransaction()
        try {
            // 3. 恢复执行实例，使用从历史表获得的所有信息
            const insertExecSql = `
                INSERT INTO ACT_RU_EXECUTION (
                    ID_, REV_, PROC_INST_ID_, BUSINESS_KEY_, 
                    PROC_DEF_ID_, IS_ACTIVE_, IS_SCOPE_,
                    START_TIME_, START_USER_ID_
                ) VALUES (?, 1, ?, ?, ?, 1, 1, ?, ?)
            `
            await db.execute(insertExecSql, [instanceId, instanceId, taskData.businessKey, taskData.procDefId, taskData.startTime, taskData.startUserId])
            
            // 4. 查询身份关联（候选人）
            const identitySql = `
                SELECT TYPE_ as \`type\`, USER_ID_ as userId, GROUP_ID_ as groupId, TASK_ID_ as taskId, PROC_INST_ID_ as procInstId
                FROM ACT_HI_IDENTITYLINK
                WHERE TASK_ID_ = ? AND TYPE_ = 'candidate'
            `
            const [identityLinks] = await db.execute(identitySql, [targetTaskId])
            
            // 5. 确定任务审批人：如果没有候选人，使用历史任务的审批人
            let taskAssignee = null
            if (identityLinks.length === 0) {
                taskAssignee = taskData.taskAssignee
            }
            
            // 6. 创建任务，使用原来的任务ID
            const insertTaskSql = `
                INSERT INTO ACT_RU_TASK (
                    ID_, REV_, NAME_, PRIORITY_, 
                    CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                    PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
                ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, 1)
            `
            await db.execute(insertTaskSql, [
                targetTaskId, 
                taskData.taskName, 
                taskData.priority || 50, 
                taskData.taskCreateTime, 
                taskAssignee,
                instanceId, 
                instanceId, 
                taskData.procDefId, 
                taskData.taskDefKey
            ])
            
            // 7. 恢复身份关联（仅当有候选人时）
            for (const link of identityLinks) {
                const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const insertLinkSql = `
                    INSERT INTO ACT_RU_IDENTITYLINK (
                        ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                    ) VALUES (?, 1, ?, ?, ?, ?, ?)
                `
                await db.execute(insertLinkSql, [linkId, link.type, link.userId, link.groupId, targetTaskId, instanceId])
            }
            
            // 8. 恢复变量
            const selectVarSql = `
                SELECT NAME_ as name, VAR_TYPE_ as varType, TEXT_ as \`text\`, TEXT2_ as text2, DOUBLE_ as \`double\`, LONG_ as \`long\`, BYTEARRAY_ID_ as bytearrayId
                FROM ACT_HI_VARINST
                WHERE PROC_INST_ID_ = ? 
                  AND NAME_ IS NOT NULL
            `
            const [varRows] = await db.execute(selectVarSql, [instanceId])
            
            for (const v of varRows) {
                const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const varType = v.varType || 'string'
                
                const insertVarSql = `
                    INSERT INTO ACT_RU_VARIABLE (
                        ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                        TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
                `
                await db.execute(insertVarSql, [
                    varId, 
                    v.name, 
                    varType, 
                    instanceId, 
                    v.text, 
                    v.text2, 
                    v.double, 
                    v.long, 
                    v.bytearrayId
                ])
            }
            
            // 9. 删除目标任务之后的历史活动
            if (taskIdsToDelete.length > 0) {
                const placeholders = taskIdsToDelete.map(() => '?').join(',')
                const delActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
                await db.execute(delActInstSql, taskIdsToDelete)
                
                // 10. 删除目标任务之后的历史任务
                const delTaskInstSql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
                await db.execute(delTaskInstSql, taskIdsToDelete)
            }
            
            // 11. 删除活动历史
            const delAllActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = ?`
            await db.execute(delAllActInstSql, [instanceId])
            
            // 12. 更新目标历史任务
            const updateTaskSql = `
                UPDATE ACT_HI_TASKINST 
                SET END_TIME_ = NULL, DELETE_REASON_ = NULL
                WHERE ID_ = ?
            `
            await db.execute(updateTaskSql, [targetTaskId])
            
            // 13. 更新历史流程实例
            const updateProcInstSql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = ?`
            await db.execute(updateProcInstSql, [instanceId])
            
            // 提交事务
            await db.commit()
        } catch (error) {
            // 回滚事务
            await db.rollback()
            throw error
        }
    } else {
        // 瀚高/PostgreSQL 版本
        const client = await db.connect()
        try {
            await client.query('BEGIN')
            
            const pgInsertExecSql = `
                INSERT INTO ACT_RU_EXECUTION (
                    ID_, REV_, PROC_INST_ID_, BUSINESS_KEY_, 
                    PROC_DEF_ID_, IS_ACTIVE_, IS_SCOPE_,
                    START_TIME_, START_USER_ID_
                ) VALUES ($1, 1, $2, $3, $4, true, true, $5, $6)
            `
            await client.query(pgInsertExecSql, [instanceId, instanceId, taskData.businessKey, taskData.procDefId, taskData.startTime, taskData.startUserId])
            
            // 查询身份关联（候选人）
            const pgIdentitySql = `
                SELECT TYPE_ as "type", USER_ID_ as userId, GROUP_ID_ as groupId, TASK_ID_ as taskId, PROC_INST_ID_ as procInstId
                FROM ACT_HI_IDENTITYLINK
                WHERE TASK_ID_ = $1 AND TYPE_ = 'candidate'
            `
            const identityResult = await client.query(pgIdentitySql, [targetTaskId])
            const identityLinks = identityResult.rows
            
            // 确定任务审批人：如果没有候选人，使用历史任务的审批人
            let taskAssignee = null
            if (identityLinks.length === 0) {
                taskAssignee = taskData.taskAssignee
            }
            
            // 创建任务，使用原来的任务ID
            const pgInsertTaskSql = `
                INSERT INTO ACT_RU_TASK (
                    ID_, REV_, NAME_, PRIORITY_, 
                    CREATE_TIME_, ASSIGNEE_, EXECUTION_ID_, PROC_INST_ID_, 
                    PROC_DEF_ID_, TASK_DEF_KEY_, SUSPENSION_STATE_
                ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, 1)
            `
            await client.query(pgInsertTaskSql, [
                targetTaskId, 
                taskData.taskName, 
                taskData.priority || 50, 
                taskData.taskCreateTime, 
                taskAssignee,
                instanceId, 
                instanceId, 
                taskData.procDefId, 
                taskData.taskDefKey
            ])
            
            // 恢复身份关联（仅当有候选人时）
            for (const link of identityLinks) {
                const linkId = `link_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const pgInsertLinkSql = `
                    INSERT INTO ACT_RU_IDENTITYLINK (
                        ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_
                    ) VALUES ($1, 1, $2, $3, $4, $5, $6)
                `
                await client.query(pgInsertLinkSql, [linkId, link.type, link.userId, link.groupId, targetTaskId, instanceId])
            }
            
            const pgSelectVarSql = `
                SELECT NAME_ as name, VAR_TYPE_ as varType, TEXT_ as "text", TEXT2_ as text2, DOUBLE_ as "double", LONG_ as "long", BYTEARRAY_ID_ as bytearrayId
                FROM ACT_HI_VARINST
                WHERE PROC_INST_ID_ = $1
                  AND NAME_ IS NOT NULL
            `
            const varResult = await client.query(pgSelectVarSql, [instanceId])
            const varRows = varResult.rows
            
            for (const v of varRows) {
                const varId = `var_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
                const varType = v.varType || 'string'
                
                const pgInsertVarSql = `
                    INSERT INTO ACT_RU_VARIABLE (
                        ID_, REV_, NAME_, TYPE_, PROC_INST_ID_,
                        TEXT_, TEXT2_, DOUBLE_, LONG_, BYTEARRAY_ID_
                    ) VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9)
                `
                await client.query(pgInsertVarSql, [
                    varId, 
                    v.name, 
                    varType, 
                    instanceId, 
                    v.text, 
                    v.text2, 
                    v.double, 
                    v.long, 
                    v.bytearrayId
                ])
            }
            
            // 删除目标任务之后的历史
            if (taskIdsToDelete.length > 0) {
                const placeholders = taskIdsToDelete.map((_, i) => `$${i + 1}`).join(',')
                const pgDelActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE TASK_ID_ IN (${placeholders})`
                await client.query(pgDelActInstSql, taskIdsToDelete)
                
                const pgDelTaskInstSql = `DELETE FROM ACT_HI_TASKINST WHERE ID_ IN (${placeholders})`
                await client.query(pgDelTaskInstSql, taskIdsToDelete)
            }
            
            const pgDelAllActInstSql = `DELETE FROM ACT_HI_ACTINST WHERE PROC_INST_ID_ = $1`
            await client.query(pgDelAllActInstSql, [instanceId])
            
            const pgUpdateTaskSql = `
                UPDATE ACT_HI_TASKINST 
                SET END_TIME_ = NULL, DELETE_REASON_ = NULL
                WHERE ID_ = $1
            `
            await client.query(pgUpdateTaskSql, [targetTaskId])
            
            const pgUpdateProcInstSql = `UPDATE ACT_HI_PROCINST SET END_TIME_ = NULL WHERE ID_ = $1`
            await client.query(pgUpdateProcInstSql, [instanceId])
            
            await client.query('COMMIT')
        } catch (error) {
            await client.query('ROLLBACK')
            throw error
        } finally {
            client.release()
        }
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
            SELECT il.ID_ as id, il.TYPE_ as \`type\`, il.USER_ID_ as userId, il.GROUP_ID_ as groupId,
                   su.username, su.realname
            FROM ACT_RU_IDENTITYLINK il
            LEFT JOIN sys_user su ON il.USER_ID_ = su.id
            WHERE il.TASK_ID_ = ? AND il.TYPE_ = 'candidate' AND il.USER_ID_ IS NOT NULL
        `
        const [rows] = await db.execute(sql, [taskId])
        return rows
    } else {
        sql = `
            SELECT il.ID_ as id, il.TYPE_ as "type", il.USER_ID_ as userId, il.GROUP_ID_ as groupId,
                   su.username, su.realname
            FROM ACT_RU_IDENTITYLINK il
            LEFT JOIN sys_user su ON il.USER_ID_ = su.id
            WHERE il.TASK_ID_ = $1 AND il.TYPE_ = 'candidate' AND il.USER_ID_ IS NOT NULL
        `
        return await query(db, dbType, sql, [taskId])
    }
}

async function getUsers(dbType, keyword = '') {
    // 优先加载完整用户列表
    if (!cachedUsers) {
        let sql
        if (dbType === 'mysql') {
            sql = `SELECT id, username, realname FROM sys_user ORDER BY username`
            const rows = await query(activitiDb, dbType, sql, [])
            cachedUsers = rows
        } else {
            sql = `SELECT id, username, realname FROM sys_user ORDER BY username`
            const rows = await query(activitiDb, dbType, sql, [])
            cachedUsers = rows
        }
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

async function updateHistoryTaskAssignee(db, dbType, taskId, assignee, endTime) {
    // 统一转换日期格式
    let formattedDate = null
    if (endTime) {
        const date = new Date(endTime)
        if (!isNaN(date.getTime())) {
            if (dbType === 'mysql') {
                // MySQL格式: YYYY-MM-DD HH:mm:ss
                formattedDate = date.toISOString().replace('T', ' ').substring(0, 19)
            } else {
                // PostgreSQL/瀚高可以直接用 Date 对象或 ISO 格式
                formattedDate = date
            }
        }
    }
    
    let sql
    if (dbType === 'mysql') {
        sql = 'UPDATE ACT_HI_TASKINST SET ASSIGNEE_ = ?, END_TIME_ = ? WHERE ID_ = ?'
        await db.execute(sql, [assignee, formattedDate, taskId])
        
        sql = 'UPDATE ACT_HI_IDENTITYLINK SET USER_ID_ = ? WHERE TASK_ID_ = ? AND TYPE_ = \'assignee\''
        await db.execute(sql, [assignee, taskId])
    } else {
        sql = 'UPDATE ACT_HI_TASKINST SET ASSIGNEE_ = $1, END_TIME_ = $2 WHERE ID_ = $3'
        await db.query(sql, [assignee, formattedDate, taskId])
        
        sql = 'UPDATE ACT_HI_IDENTITYLINK SET USER_ID_ = $1 WHERE TASK_ID_ = $2 AND TYPE_ = $3'
        await db.query(sql, [assignee, taskId, 'assignee'])
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
        if (dbConfig?.dbType === 'postgres' || dbConfig?.dbType === 'hgdatabase') {
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
