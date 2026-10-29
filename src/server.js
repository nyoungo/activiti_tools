'use strict'

const express = require('express')
const path = require('path')
const fs = require('fs')
const crypto = require('crypto')
const { exec } = require('child_process')
const mysql = require('mysql2/promise')
const { Pool, types: pgTypes } = require('pg')
const initSqlJs = require('sql.js')

const PORT = Number(process.env.PORT) || 34567
const MAX_PAGE_SIZE = 200
const AUDIT_LIMIT = 1000

// BIGINT 统一转 Number，避免统计值以字符串返回
pgTypes.setTypeParser(20, (value) => (value === null ? null : Number(value)))

// Activiti 的 *_TIME_ 列是 timestamp without time zone（数据库本地时间）。
// 默认会被解析成 UTC 的 Date，导致东八区页面多加 8 小时；
// 这里返回不带时区的 ISO 字符串，由前端按本地时间展示。
pgTypes.setTypeParser(1114, (value) => (value ? String(value).replace(' ', 'T') : value))

const app = express()

function getAppRoot() {
    if (process.pkg) return path.dirname(process.execPath)
    return path.join(__dirname, '..')
}

const CONFIG_DB_PATH = process.env.ACTIVITI_TOOLS_CONFIG || path.join(getAppRoot(), 'config.db')

function getPublicPath() {
    const candidates = process.pkg
        ? [
            path.join(path.dirname(process.execPath), 'src', 'public'),
            path.join(path.dirname(process.execPath), 'public'),
            path.join(path.dirname(process.execPath), 'snapshot', 'src', 'public'),
            path.join(__dirname, 'public')
        ]
        : [path.join(__dirname, 'public')]

    const found = candidates.find((dir) => fs.existsSync(path.join(dir, 'index.html')))
    if (!found) {
        console.warn('[WARN] 未找到前端静态资源，尝试过的路径: ' + candidates.join(', '))
    }
    return found || candidates[0]
}

// ==================== 错误与工具 ====================

class ApiError extends Error {
    constructor(message, status = 400) {
        super(message)
        this.status = status
    }
}

const wrap = (handler) => async (req, res) => {
    try {
        await handler(req, res)
    } catch (error) {
        const status = error instanceof ApiError ? error.status : 500
        if (status >= 500) {
            console.error(`[ERROR] ${req.method} ${req.originalUrl}:`, error)
        }
        if (!res.headersSent) {
            res.status(status).json({ error: error.message || '服务器内部错误' })
        }
    }
}

function newId() {
    return crypto.randomUUID()
}

function requireString(value, label, maxLength = 255) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new ApiError(`${label}不能为空`)
    }
    if (value.length > maxLength) {
        throw new ApiError(`${label}过长，最多 ${maxLength} 个字符`)
    }
    return value.trim()
}

function toInt(value, fallback) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : fallback
}

function parsePaging(query) {
    const page = Math.max(1, toInt(query.page, 1))
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, toInt(query.size, 10)))
    return { page, size, offset: (page - 1) * size }
}

function placeholders(count) {
    return Array.from({ length: count }, () => '?').join(',')
}

function isTrue(value) {
    return value === true || value === 'true' || value === 1 || value === '1'
}

// 生成跨数据库的布尔字面量（MySQL tinyint / PostgreSQL boolean）
function boolLiteral(value) {
    if (isMysql()) return value ? '1' : '0'
    return value ? 'true' : 'false'
}

// PG 的 LIKE 区分大小写，统一使用 ILIKE
function likeOp() {
    return isMysql() ? 'LIKE' : 'ILIKE'
}

// 把 SQL 中的 ? 占位符转换为 PG 的 $1,$2...（跳过字符串字面量）
function toPgSql(sql) {
    let result = ''
    let index = 0
    let paramIndex = 1
    let inString = false
    while (index < sql.length) {
        const char = sql[index]
        if (inString) {
            result += char
            if (char === "'") {
                if (sql[index + 1] === "'") {
                    result += sql[index + 1]
                    index += 2
                    continue
                }
                inString = false
            }
            index += 1
            continue
        }
        if (char === "'") {
            inString = true
            result += char
            index += 1
            continue
        }
        if (char === '?') {
            result += `$${paramIndex++}`
            index += 1
            continue
        }
        result += char
        index += 1
    }
    return result
}

function toCamelCase(key) {
    return key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())
}

function convertRow(row) {
    if (!row || typeof row !== 'object') return row
    if (row instanceof Date || Buffer.isBuffer(row)) return row
    const result = {}
    for (const key of Object.keys(row)) {
        result[toCamelCase(key)] = row[key]
    }
    return result
}

function toBuffer(value) {
    if (value === null || value === undefined) return null
    if (Buffer.isBuffer(value)) return value
    if (value instanceof Uint8Array) return Buffer.from(value)
    if (typeof value === 'string') return Buffer.from(value, 'utf8')
    return null
}

function startOfToday() {
    const now = new Date()
    return new Date(now.getFullYear(), now.getMonth(), now.getDate())
}

// ==================== 本地配置库（sql.js） ====================

let localDb = null

async function initLocalDb() {
    const SQL = await initSqlJs()
    try {
        if (fs.existsSync(CONFIG_DB_PATH)) {
            localDb = new SQL.Database(fs.readFileSync(CONFIG_DB_PATH))
        } else {
            localDb = new SQL.Database()
        }
    } catch (error) {
        console.warn('[WARN] 本地配置文件损坏，已重新初始化:', error.message)
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
    localDb.run(`
        CREATE TABLE IF NOT EXISTS audit_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            action TEXT NOT NULL,
            target TEXT,
            detail TEXT
        )
    `)
    // 兼容旧版本：补齐 schema 字段
    try {
        localDb.run('ALTER TABLE connections ADD COLUMN schema TEXT')
    } catch (error) {
        // 字段已存在
    }
    saveLocalDb()
}

function saveLocalDb() {
    if (!localDb) return
    try {
        fs.writeFileSync(CONFIG_DB_PATH, Buffer.from(localDb.export()))
    } catch (error) {
        console.error('[ERROR] 保存本地配置失败:', error.message)
    }
}

function localAll(sql, params = []) {
    if (!localDb) return []
    const statement = localDb.prepare(sql)
    try {
        statement.bind(params)
        const rows = []
        while (statement.step()) rows.push(statement.getAsObject())
        return rows
    } finally {
        statement.free()
    }
}

function logAudit(action, target, detail) {
    if (!localDb) return
    try {
        localDb.run(
            'INSERT INTO audit_logs (created_at, action, target, detail) VALUES (?, ?, ?, ?)',
            [new Date().toISOString(), action, String(target || ''), String(detail || '')]
        )
        localDb.run('DELETE FROM audit_logs WHERE id <= (SELECT MAX(id) - ? FROM audit_logs)', [AUDIT_LIMIT])
        saveLocalDb()
    } catch (error) {
        console.error('[AUDIT]', error.message)
    }
}

// ==================== Activiti 连接管理 ====================

const dbState = {
    pool: null,
    type: null,
    config: null,
    tables: new Set(),
    users: null,
    userColumns: null,
    userColumnsLoaded: false
}

function isMysql() {
    return dbState.type === 'mysql'
}

function isPostgres() {
    return dbState.type === 'postgres' || dbState.type === 'hgdatabase'
}

function hasTable(name) {
    return dbState.tables.has(String(name).toLowerCase())
}

function requireConnection(req, res, next) {
    if (!dbState.pool) {
        return res.status(409).json({ error: '尚未连接数据库，请先连接' })
    }
    next()
}

function defaultPort(dbType) {
    if (dbType === 'mysql') return 3306
    if (dbType === 'hgdatabase') return 5866
    return 5432
}

function normalizeConfig(input = {}) {
    const dbType = ['mysql', 'postgres', 'hgdatabase'].includes(input.dbType) ? input.dbType : 'mysql'
    return {
        name: typeof input.name === 'string' ? input.name.trim() : '',
        dbType,
        host: typeof input.host === 'string' && input.host.trim() ? input.host.trim() : 'localhost',
        port: toInt(input.port, defaultPort(dbType)),
        database: typeof input.database === 'string' ? input.database.trim() : '',
        username: typeof input.username === 'string' ? input.username : '',
        password: typeof input.password === 'string' ? input.password : '',
        schema: typeof input.schema === 'string' ? input.schema.trim() : ''
    }
}

function buildMysqlPool(config) {
    return mysql.createPool({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database || undefined,
        waitForConnections: true,
        connectionLimit: 5,
        charset: 'utf8mb4',
        supportBigNumbers: true,
        bigNumberStrings: false,
        dateStrings: false
    })
}

function buildPgPool(config) {
    const poolConfig = {
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database || 'postgres',
        max: 5,
        connectionTimeoutMillis: 15000
    }
    if (config.schema) {
        poolConfig.options = `-c search_path=${config.schema}`
    }
    return new Pool(poolConfig)
}

async function createPool(config) {
    return isPoolForMysql(config) ? buildMysqlPool(config) : buildPgPool(config)
}

function isPoolForMysql(config) {
    return config.dbType === 'mysql'
}

async function closePool(pool, config) {
    if (!pool) return
    try {
        await pool.end()
    } catch (error) {
        console.warn('[WARN] 关闭连接池失败:', error.message)
    }
}

async function loadTableSet(pool, dbType) {
    const tables = new Set()
    try {
        if (dbType === 'mysql') {
            const [rows] = await pool.query(
                'SELECT TABLE_NAME AS name FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()'
            )
            rows.forEach((row) => tables.add(String(row.name).toLowerCase()))
        } else {
            const result = await pool.query(
                'SELECT table_name AS name FROM information_schema.tables WHERE table_schema = current_schema()'
            )
            result.rows.forEach((row) => tables.add(String(row.name).toLowerCase()))
        }
    } catch (error) {
        console.error('[SCHEMA] 读取表结构失败:', error.message)
    }
    return tables
}

// ==================== 统一 SQL 执行层 ====================

async function query(sql, params = [], executor = null) {
    const target = executor || dbState.pool
    if (!target) throw new ApiError('尚未连接数据库，请先连接', 409)

    if (isMysql()) {
        const [rows] = await target.query(sql, params)
        if (!Array.isArray(rows)) return []
        return rows.map(convertRow)
    }

    const result = await target.query(toPgSql(sql), params)
    return (result.rows || []).map(convertRow)
}

async function execute(sql, params = [], executor = null) {
    const target = executor || dbState.pool
    if (!target) throw new ApiError('尚未连接数据库，请先连接', 409)

    if (isMysql()) {
        const [result] = await target.query(sql, params)
        return { affectedRows: result ? result.affectedRows : 0 }
    }

    const result = await target.query(toPgSql(sql), params)
    return { affectedRows: result.rowCount || 0 }
}

/**
 * 事务执行：MySQL 复用连接池连接并 beginTransaction，
 * PostgreSQL 通过 client 执行 BEGIN/COMMIT。
 */
async function withTransaction(work) {
    if (!dbState.pool) throw new ApiError('尚未连接数据库，请先连接', 409)

    if (isMysql()) {
        const connection = await dbState.pool.getConnection()
        try {
            await connection.beginTransaction()
            const result = await work({
                query: (sql, params) => query(sql, params, connection),
                execute: (sql, params) => execute(sql, params, connection)
            })
            await connection.commit()
            return result
        } catch (error) {
            try {
                await connection.rollback()
            } catch (rollbackError) {
                console.error('[TX] 回滚失败:', rollbackError.message)
            }
            throw error
        } finally {
            connection.release()
        }
    }

    const client = await dbState.pool.connect()
    try {
        await client.query('BEGIN')
        const result = await work({
            query: (sql, params) => query(sql, params, client),
            execute: (sql, params) => execute(sql, params, client)
        })
        await client.query('COMMIT')
        return result
    } catch (error) {
        try {
            await client.query('ROLLBACK')
        } catch (rollbackError) {
            console.error('[TX] 回滚失败:', rollbackError.message)
        }
        throw error
    } finally {
        client.release()
    }
}

async function countRows(table, where = '', params = []) {
    if (!hasTable(table)) return 0
    const rows = await query(
        `SELECT COUNT(*) AS "total" FROM ${table} ${where ? `WHERE ${where}` : ''}`,
        params
    )
    return Number(rows[0]?.total || 0)
}

async function safeCount(table, where = '', params = []) {
    if (!hasTable(table)) return null
    try {
        return await countRows(table, where, params)
    } catch (error) {
        console.warn(`[COUNT] ${table}:`, error.message)
        return null
    }
}

// ==================== 用户信息（容错解析 sys_user） ====================

const columnCache = new Map()

/**
 * 结构探测兜底：information_schema 拿不到时，用 SELECT * ... WHERE 1 = 0
 * 读取驱动返回的字段元数据（瀚高 / 部分代理层会限制 information_schema 访问）。
 */
async function describeColumns(table) {
    if (!dbState.pool) return []
    try {
        if (isMysql()) {
            const [, fields] = await dbState.pool.query(`SELECT * FROM ${table} WHERE 1 = 0`)
            return (fields || []).map((field) => String(field.name).toLowerCase())
        }
        const result = await dbState.pool.query(`SELECT * FROM ${table} WHERE 1 = 0`)
        return (result.fields || []).map((field) => String(field.name).toLowerCase())
    } catch (error) {
        console.warn(`[COLUMNS] ${table} 结构探测失败:`, error.message)
        return []
    }
}

async function getColumns(table) {
    const key = String(table).toLowerCase()
    if (columnCache.has(key)) return columnCache.get(key)
    let columns = []
    try {
        const sql = isMysql()
            ? 'SELECT COLUMN_NAME AS "name" FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND LOWER(TABLE_NAME) = ?'
            : 'SELECT column_name AS "name" FROM information_schema.columns WHERE table_schema = current_schema() AND LOWER(table_name) = ?'
        const rows = await query(sql, [key])
        columns = rows.map((row) => String(row.name).toLowerCase())
    } catch (error) {
        console.warn(`[COLUMNS] ${table}:`, error.message)
    }
    if (columns.length === 0) columns = await describeColumns(key)
    // 只有探测成功才缓存，避免一次失败后永久按空结构处理
    if (columns.length > 0) columnCache.set(key, columns)
    return columns
}

async function hasColumn(table, column) {
    const columns = await getColumns(table)
    return columns.length > 0 && columns.includes(String(column).toLowerCase())
}

/** 从候选列名中挑出当前库真实存在的那一个；结构未知时取第一个（按标准结构处理） */
function pickColumn(columns, candidates) {
    if (!columns || columns.length === 0) return candidates[0]
    return candidates.find((candidate) => columns.includes(candidate.toLowerCase())) || null
}

/**
 * 不同 Activiti 6.0 库的列并不完全一致：标准脚本里 act_ru_variable / act_hi_varinst
 * 没有 TENANT_ID_（只有定制的 tenant_id），而 act_ru_execution / act_ru_task /
 * act_hi_taskinst 等又有，写死列名会直接报 "column ... does not exist"。
 *
 * spec 每项：{ name, param } 走占位符传参、{ name, literal } 走 SQL 字面量，
 * optional: true 表示该列在当前库不存在时直接跳过（列结构未知时也会跳过）。
 */
async function buildInsert(table, spec) {
    const present = await getColumns(table)
    const usable = spec.filter((item) =>
        present.length === 0 ? !item.optional : present.includes(item.name.toLowerCase())
    )
    const usesParam = (item) => Object.prototype.hasOwnProperty.call(item, 'param')
    const sql = `INSERT INTO ${table} (${usable.map((item) => item.name).join(', ')}) VALUES (${usable
        .map((item) => (usesParam(item) ? '?' : item.literal))
        .join(', ')})`
    return { sql, params: usable.filter(usesParam).map((item) => item.param) }
}

async function getUserColumns() {
    if (dbState.userColumnsLoaded) return dbState.userColumns
    const columns = await getColumns('sys_user')
    const pick = (candidates) => candidates.find((candidate) => columns.includes(candidate)) || null
    dbState.userColumns = {
        id: pick(['id', 'user_id']),
        username: pick(['username', 'user_name', 'login_name', 'account']),
        realname: pick(['realname', 'real_name', 'nick_name', 'full_name', 'name'])
    }
    dbState.userColumnsLoaded = true
    return dbState.userColumns
}

async function loadUsers(force = false) {
    if (!force && dbState.users) return dbState.users

    const cache = { byId: new Map(), byUsername: new Map(), list: [] }
    dbState.users = cache

    if (!hasTable('sys_user')) return cache

    const columns = await getUserColumns()
    if (!columns.id) return cache

    try {
        const select = [
            `u.${columns.id} AS "id"`,
            columns.username ? `u.${columns.username} AS "username"` : 'NULL AS "username"',
            columns.realname ? `u.${columns.realname} AS "realname"` : 'NULL AS "realname"'
        ]
        const rows = await query(`SELECT ${select.join(', ')} FROM sys_user u`)
        for (const row of rows) {
            const user = {
                id: row.id === null || row.id === undefined ? null : String(row.id),
                username: row.username === null || row.username === undefined ? null : String(row.username),
                realname: row.realname === null || row.realname === undefined ? null : String(row.realname)
            }
            if (user.id) cache.byId.set(user.id, user)
            if (user.username) cache.byUsername.set(user.username, user)
            cache.list.push(user)
        }
        cache.list.sort((a, b) => (userLabelOf(cache, a.id) || '').localeCompare(userLabelOf(cache, b.id) || '', 'zh-CN'))
    } catch (error) {
        console.warn('[USERS] 读取 sys_user 失败:', error.message)
    }
    return cache
}

function userLabelOf(cache, value) {
    if (value === null || value === undefined || value === '') return null
    const key = String(value)
    const user = cache.byId.get(key) || cache.byUsername.get(key)
    if (!user) return null
    return user.realname || user.username || key
}

function userLabel(value) {
    return userLabelOf(dbState.users || { byId: new Map(), byUsername: new Map() }, value) || value
}

async function resolveUsersByRoles(roleCodes) {
    if (!roleCodes || roleCodes.length === 0) return []
    if (!hasTable('sys_user_role') || !hasTable('sys_role')) return []

    const columns = await getUserColumns()
    if (!columns.id) return []

    try {
        const roleColumns = await getColumns('sys_role')
        const roleCodeColumn = ['role_code', 'code', 'role_key'].find((name) => roleColumns.includes(name))
        if (!roleCodeColumn) return []

        const userRoleColumns = await getColumns('sys_user_role')
        const userColumn = ['user_id', 'userid', 'user'].find((name) => userRoleColumns.includes(name))
        const roleColumn = ['role_id', 'roleid', 'role'].find((name) => userRoleColumns.includes(name))
        if (!userColumn || !roleColumn) return []

        const idColumn = ['id', 'role_id'].find((name) => roleColumns.includes(name))
        if (!idColumn) return []

        const names = roleCodes.map((code) => String(code).trim()).filter(Boolean)
        if (names.length === 0) return []

        const select = [
            `DISTINCT u.${columns.id} AS "id"`,
            columns.username ? `u.${columns.username} AS "username"` : 'NULL AS "username"',
            columns.realname ? `u.${columns.realname} AS "realname"` : 'NULL AS "realname"'
        ]
        const sql = `
            SELECT ${select.join(', ')}
            FROM sys_user u
            JOIN sys_user_role ur ON u.${columns.id} = ur.${userColumn}
            JOIN sys_role r ON ur.${roleColumn} = r.${idColumn}
            WHERE r.${roleCodeColumn} IN (${placeholders(names.length)})
        `
        return await query(sql, names)
    } catch (error) {
        console.warn('[ROLES] 按角色查用户失败:', error.message)
        return []
    }
}

async function ensureUsersFresh() {
    if (!dbState.users) await loadUsers()
    return dbState.users
}

// ==================== BPMN 解析 ====================

const NODE_TYPES = [
    'startEvent', 'endEvent', 'userTask', 'serviceTask', 'scriptTask', 'manualTask',
    'businessRuleTask', 'sendTask', 'receiveTask', 'callActivity', 'subProcess',
    'exclusiveGateway', 'parallelGateway', 'inclusiveGateway', 'eventBasedGateway',
    'complexGateway', 'intermediateCatchEvent', 'intermediateThrowEvent', 'boundaryEvent'
]

function parseAttributes(source) {
    const attributes = {}
    const regex = /([\w:.-]+)\s*=\s*"([^"]*)"/g
    let match
    while ((match = regex.exec(source))) {
        const name = match[1]
        attributes[name] = match[2]
        // 同时写入去掉命名空间前缀的属性名，兼容 activiti:assignee / flowable:assignee
        const localName = name.includes(':') ? name.split(':').pop() : name
        if (!(localName in attributes)) {
            attributes[localName] = match[2]
        }
    }
    return attributes
}

function parseBpmnNodes(xml) {
    if (!xml) return []
    const nodes = []
    const seen = new Set()
    const regex = new RegExp(`<([a-zA-Z0-9]+:)?(${NODE_TYPES.join('|')})\\b([^>]*)>`, 'g')
    let match
    while ((match = regex.exec(xml))) {
        const attributes = parseAttributes(match[3] || '')
        if (!attributes.id || seen.has(attributes.id)) continue
        seen.add(attributes.id)
        nodes.push({
            id: attributes.id,
            name: attributes.name || attributes.id,
            type: match[2],
            assignee: attributes.assignee || null,
            candidateUsers: attributes.candidateUsers || null,
            candidateGroups: attributes.candidateGroups || null
        })
    }
    return nodes
}

function isExpression(value) {
    return typeof value === 'string' && value.includes('${')
}

function splitList(value) {
    if (!value) return []
    return String(value)
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item && !isExpression(item))
}

const definitionXmlCache = new Map()

function cacheDefinitionXml(definitionId, xml) {
    if (definitionXmlCache.size > 20) {
        const firstKey = definitionXmlCache.keys().next().value
        definitionXmlCache.delete(firstKey)
    }
    definitionXmlCache.set(definitionId, xml)
}

// ==================== 流程定义读取 ====================

async function getDefinition(definitionId) {
    const rows = await query(
        `SELECT p.ID_ AS "id", p.KEY_ AS "key", p.NAME_ AS "name", p.VERSION_ AS "version",
                p.DEPLOYMENT_ID_ AS "deploymentId", p.RESOURCE_NAME_ AS "resourceName",
                p.SUSPENSION_STATE_ AS "suspensionState"
         FROM act_re_procdef p WHERE p.ID_ = ?`,
        [definitionId]
    )
    if (rows.length === 0) throw new ApiError('流程定义不存在', 404)
    return rows[0]
}

async function readDefinitionXml(definitionId, definition = null) {
    if (definitionXmlCache.has(definitionId)) return definitionXmlCache.get(definitionId)

    const def = definition || await getDefinition(definitionId)
    if (!hasTable('act_ge_bytearray') || !def.deploymentId) {
        cacheDefinitionXml(definitionId, '')
        return ''
    }

    let rows = []
    if (def.resourceName) {
        rows = await query(
            'SELECT BYTES_ AS "bytes" FROM act_ge_bytearray WHERE DEPLOYMENT_ID_ = ? AND NAME_ = ?',
            [def.deploymentId, def.resourceName]
        )
    }
    if (rows.length === 0) {
        rows = await query(
            `SELECT BYTES_ AS "bytes" FROM act_ge_bytearray
             WHERE DEPLOYMENT_ID_ = ? AND (NAME_ ${likeOp()} ? OR NAME_ ${likeOp()} ?)
             ORDER BY NAME_ ASC`,
            [def.deploymentId, '%.bpmn%', '%.bpmn20%']
        )
    }

    const buffer = rows.length > 0 ? toBuffer(rows[0].bytes) : null
    const xml = buffer ? buffer.toString('utf8') : ''
    cacheDefinitionXml(definitionId, xml)
    return xml
}

async function findByteArrayId(definitionId, definition = null) {
    const def = definition || await getDefinition(definitionId)
    if (!hasTable('act_ge_bytearray') || !def.deploymentId) return null

    let rows = []
    if (def.resourceName) {
        rows = await query(
            'SELECT ID_ AS "id" FROM act_ge_bytearray WHERE DEPLOYMENT_ID_ = ? AND NAME_ = ?',
            [def.deploymentId, def.resourceName]
        )
    }
    if (rows.length === 0) {
        rows = await query(
            `SELECT ID_ AS "id" FROM act_ge_bytearray
             WHERE DEPLOYMENT_ID_ = ? AND NAME_ ${likeOp()} ?
             ORDER BY NAME_ ASC`,
            [def.deploymentId, '%.bpmn%']
        )
    }
    return rows.length > 0 ? rows[0].id : null
}

// ==================== 流程实例 ====================

function taskStatusLabel(instance) {
    if (instance.isFinished) return '已结束'
    if (Number(instance.suspensionState) === 2) return '已挂起'
    return '运行中'
}

async function attachTaskCandidates(tasks, executor) {
    if (!tasks || tasks.length === 0) return tasks
    tasks.forEach((task) => { task.candidates = [] })
    if (!hasTable('act_ru_identitylink')) return tasks

    const taskIds = tasks.map((task) => task.id)
    const rows = await query(
        `SELECT il.TASK_ID_ AS "taskId", il.USER_ID_ AS "userId", il.GROUP_ID_ AS "groupId", il.TYPE_ AS "type"
         FROM act_ru_identitylink il
         WHERE il.TASK_ID_ IN (${placeholders(taskIds.length)})
           AND (il.USER_ID_ IS NOT NULL OR il.GROUP_ID_ IS NOT NULL)`,
        taskIds,
        executor
    )

    const byTask = new Map()
    for (const row of rows) {
        if (!byTask.has(row.taskId)) byTask.set(row.taskId, [])
        byTask.get(row.taskId).push({
            userId: row.userId || null,
            groupId: row.groupId || null,
            type: row.type || 'candidate',
            label: row.userId ? userLabel(row.userId) : `组:${row.groupId}`
        })
    }
    for (const task of tasks) {
        task.candidates = byTask.get(task.id) || []
        task.assigneeLabel = task.assignee ? userLabel(task.assignee) : null
    }
    return tasks
}

async function loadRuntimeTasks(instanceIds, executor) {
    if (!hasTable('act_ru_task') || instanceIds.length === 0) return new Map()
    const rows = await query(
        `SELECT t.ID_ AS "id", t.NAME_ AS "name", t.ASSIGNEE_ AS "assignee", t.CREATE_TIME_ AS "createTime",
                t.DUE_DATE_ AS "dueDate", t.PRIORITY_ AS "priority", t.TASK_DEF_KEY_ AS "taskDefKey",
                t.PROC_INST_ID_ AS "procInstId", t.PROC_DEF_ID_ AS "procDefId",
                t.SUSPENSION_STATE_ AS "suspensionState", t.FORM_KEY_ AS "formKey"
         FROM act_ru_task t
         WHERE t.PROC_INST_ID_ IN (${placeholders(instanceIds.length)})
         ORDER BY t.CREATE_TIME_ ASC`,
        instanceIds,
        executor
    )
    await attachTaskCandidates(rows, executor)

    const map = new Map()
    for (const row of rows) {
        if (!map.has(row.procInstId)) map.set(row.procInstId, [])
        map.get(row.procInstId).push(row)
    }
    return map
}

async function listInstances(options) {
    const { page, size, offset } = parsePaging(options)
    const status = ['running', 'finished', 'all'].includes(options.status) ? options.status : 'running'
    const runningView = status === 'running'
    const table = runningView ? 'act_ru_execution' : 'act_hi_procinst'
    const keyword = (options.keyword || '').trim()

    const conditions = []
    const params = []

    if (runningView) conditions.push('x.PARENT_ID_ IS NULL')
    if (status === 'finished') conditions.push('x.END_TIME_ IS NOT NULL')

    if (keyword) {
        const kw = `%${keyword}%`
        conditions.push(
            `(pd.NAME_ ${likeOp()} ? OR pd.KEY_ ${likeOp()} ? OR x.BUSINESS_KEY_ ${likeOp()} ? OR x.ID_ ${likeOp()} ? OR x.START_USER_ID_ ${likeOp()} ?)`
        )
        params.push(kw, kw, kw, kw, kw)
    }
    if (options.procDefKey) {
        conditions.push('pd.KEY_ = ?')
        params.push(options.procDefKey)
    }
    if (options.startFrom) {
        conditions.push('x.START_TIME_ >= ?')
        params.push(new Date(options.startFrom))
    }
    if (options.startTo) {
        conditions.push('x.START_TIME_ <= ?')
        params.push(new Date(options.startTo))
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
    const suspensionColumn = runningView ? 'x.SUSPENSION_STATE_' : 'NULL'
    const endTimeColumn = runningView ? 'NULL' : 'x.END_TIME_'
    const deleteReasonColumn = runningView ? 'NULL' : 'x.DELETE_REASON_'

    const selectSql = `
        SELECT x.ID_ AS "id", x.PROC_DEF_ID_ AS "procDefId", pd.NAME_ AS "procDefName",
               pd.KEY_ AS "procDefKey", pd.VERSION_ AS "procDefVersion",
               x.BUSINESS_KEY_ AS "businessKey", x.START_USER_ID_ AS "startUserId",
               x.START_TIME_ AS "startTime", ${endTimeColumn} AS "endTime",
               ${suspensionColumn} AS "suspensionState", ${deleteReasonColumn} AS "deleteReason"
        FROM ${table} x
        LEFT JOIN act_re_procdef pd ON x.PROC_DEF_ID_ = pd.ID_
        ${whereSql}
        ORDER BY x.START_TIME_ DESC
        LIMIT ${size} OFFSET ${offset}
    `
    const countSql = `
        SELECT COUNT(*) AS "total"
        FROM ${table} x
        LEFT JOIN act_re_procdef pd ON x.PROC_DEF_ID_ = pd.ID_
        ${whereSql}
    `

    const instances = await query(selectSql, params)
    const totalRows = await query(countSql, params)
    const total = Number(totalRows[0]?.total || 0)

    if (instances.length === 0) return { items: [], total, page, size }

    await ensureUsersFresh()

    // 运行中实例补充历史结束时间（清理不彻底的数据）
    if (runningView) {
        const ids = instances.map((item) => item.id)
        try {
            const history = await query(
                `SELECT ID_ AS "id", END_TIME_ AS "endTime", DELETE_REASON_ AS "deleteReason"
                 FROM act_hi_procinst WHERE ID_ IN (${placeholders(ids.length)})`,
                ids
            )
            const historyMap = new Map(history.map((row) => [row.id, row]))
            for (const instance of instances) {
                const row = historyMap.get(instance.id)
                if (row) {
                    instance.endTime = row.endTime
                    instance.deleteReason = row.deleteReason
                }
            }
        } catch (error) {
            console.warn('[INSTANCES] 历史信息查询失败:', error.message)
        }
    }

    const taskMap = await loadRuntimeTasks(instances.map((item) => item.id))
    for (const instance of instances) {
        instance.currentTasks = taskMap.get(instance.id) || []
        instance.isFinished = !!instance.endTime
        instance.statusLabel = taskStatusLabel(instance)
        instance.startUserLabel = userLabel(instance.startUserId)
        instance.currentTaskNames = instance.currentTasks.map((task) => task.name).filter(Boolean).join(', ')
    }

    return { items: instances, total, page, size }
}

async function getInstanceIdentity(instanceId) {
    const runtime = await query(
        `SELECT x.ID_ AS "id", x.PROC_DEF_ID_ AS "procDefId", x.BUSINESS_KEY_ AS "businessKey",
                x.START_TIME_ AS "startTime", x.START_USER_ID_ AS "startUserId", x.TENANT_ID_ AS "tenantId",
                x.SUSPENSION_STATE_ AS "suspensionState"
         FROM act_ru_execution x
         WHERE x.ID_ = ? AND x.PARENT_ID_ IS NULL`,
        [instanceId]
    )
    if (runtime.length > 0) return { ...runtime[0], isFinished: false }

    if (!hasTable('act_hi_procinst')) return null
    const history = await query(
        `SELECT h.ID_ AS "id", h.PROC_DEF_ID_ AS "procDefId", h.BUSINESS_KEY_ AS "businessKey",
                h.START_TIME_ AS "startTime", h.START_USER_ID_ AS "startUserId", h.TENANT_ID_ AS "tenantId",
                NULL AS "suspensionState", h.END_TIME_ AS "endTime", h.NAME_ AS "name"
         FROM act_hi_procinst h WHERE h.ID_ = ?`,
        [instanceId]
    )
    if (history.length === 0) return null
    return { ...history[0], isFinished: !!history[0].endTime }
}

async function getInstanceDetail(instanceId) {
    await ensureUsersFresh()
    const identity = await getInstanceIdentity(instanceId)
    if (!identity) throw new ApiError('流程实例不存在', 404)

    const detail = {
        ...identity,
        isFinished: !!identity.isFinished,
        currentTasks: [],
        variableCount: 0,
        historyTaskCount: 0
    }

    if (detail.procDefId) {
        const definitions = await query(
            `SELECT ID_ AS "id", KEY_ AS "key", NAME_ AS "name", VERSION_ AS "version",
                    SUSPENSION_STATE_ AS "suspensionState"
             FROM act_re_procdef WHERE ID_ = ?`,
            [detail.procDefId]
        )
        if (definitions.length > 0) {
            detail.procDefName = definitions[0].name
            detail.procDefKey = definitions[0].key
            detail.procDefVersion = definitions[0].version
            detail.definitionSuspensionState = definitions[0].suspensionState
        }
    }

    const tasks = await loadRuntimeTasks([instanceId])
    detail.currentTasks = tasks.get(instanceId) || []
    detail.variableCount = await countRows('act_ru_variable', 'PROC_INST_ID_ = ?', [instanceId]).catch(() => 0)
    detail.historyTaskCount = await countRows('act_hi_taskinst', 'PROC_INST_ID_ = ?', [instanceId]).catch(() => 0)
    detail.startUserLabel = userLabel(detail.startUserId)
    detail.statusLabel = taskStatusLabel(detail)
    return detail
}

async function setInstanceSuspension(instanceId, suspended) {
    const identity = await getInstanceIdentity(instanceId)
    if (!identity) throw new ApiError('流程实例不存在', 404)
    if (identity.isFinished) throw new ApiError('流程实例已结束，无法挂起或激活')

    const stateValue = suspended ? 2 : 1
    await withTransaction(async (tx) => {
        await tx.execute(
            'UPDATE act_ru_execution SET SUSPENSION_STATE_ = ?, REV_ = REV_ + 1 WHERE ID_ = ? OR PROC_INST_ID_ = ?',
            [stateValue, instanceId, instanceId]
        )
        if (hasTable('act_ru_task')) {
            await tx.execute(
                'UPDATE act_ru_task SET SUSPENSION_STATE_ = ?, REV_ = REV_ + 1 WHERE PROC_INST_ID_ = ?',
                [stateValue, instanceId]
            )
        }
    })
    return { state: stateValue }
}

async function deleteRuntimeRows(tx, instanceId) {
    if (hasTable('act_ru_identitylink')) {
        if (hasTable('act_ru_task')) {
            await tx.execute(
                `DELETE FROM act_ru_identitylink
                 WHERE PROC_INST_ID_ = ? OR TASK_ID_ IN (SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?)`,
                [instanceId, instanceId]
            )
        } else {
            await tx.execute('DELETE FROM act_ru_identitylink WHERE PROC_INST_ID_ = ?', [instanceId])
        }
    }
    const steps = [
        ['act_ru_task', 'PROC_INST_ID_ = ?', [instanceId]],
        ['act_ru_variable', 'PROC_INST_ID_ = ?', [instanceId]],
        ['act_ru_job', 'PROCESS_INSTANCE_ID_ = ?', [instanceId]],
        ['act_ru_timer_job', 'PROCESS_INSTANCE_ID_ = ?', [instanceId]],
        ['act_ru_suspended_job', 'PROCESS_INSTANCE_ID_ = ?', [instanceId]],
        ['act_ru_deadletter_job', 'PROCESS_INSTANCE_ID_ = ?', [instanceId]],
        ['act_ru_event_subscr', 'PROC_INST_ID_ = ?', [instanceId]]
    ]
    for (const [table, condition, params] of steps) {
        if (!hasTable(table)) continue
        await tx.execute(`DELETE FROM ${table} WHERE ${condition}`, params)
    }
    if (hasTable('act_ru_execution')) {
        await tx.execute('DELETE FROM act_ru_execution WHERE PROC_INST_ID_ = ? AND ID_ <> ?', [instanceId, instanceId])
        await tx.execute('DELETE FROM act_ru_execution WHERE ID_ = ?', [instanceId])
    }
}

async function terminateInstance(instanceId, reason) {
    const identity = await getInstanceIdentity(instanceId)
    if (!identity) throw new ApiError('流程实例不存在', 404)

    const now = new Date()
    const deleteReason = reason || '运维工具终止流程'
    const warnings = []

    await withTransaction(async (tx) => {
        if (hasTable('act_hi_taskinst')) {
            await tx.execute(
                'UPDATE act_hi_taskinst SET END_TIME_ = ?, DELETE_REASON_ = ? WHERE PROC_INST_ID_ = ? AND END_TIME_ IS NULL',
                [now, deleteReason, instanceId]
            )
        }
        if (hasTable('act_hi_actinst')) {
            await tx.execute(
                'UPDATE act_hi_actinst SET END_TIME_ = ?, DELETE_REASON_ = ? WHERE PROC_INST_ID_ = ? AND END_TIME_ IS NULL',
                [now, deleteReason, instanceId]
            )
        }
        if (hasTable('act_hi_procinst')) {
            await tx.execute(
                'UPDATE act_hi_procinst SET END_TIME_ = ?, DURATION_ = ?, DELETE_REASON_ = ? WHERE ID_ = ? AND END_TIME_ IS NULL',
                [now, identity.startTime ? Math.max(0, now.getTime() - new Date(identity.startTime).getTime()) : null, deleteReason, instanceId]
            )
        }
        await deleteRuntimeRows(tx, instanceId)
    })

    if (hasTable('act_ru_timer_job') || hasTable('act_ru_job')) {
        warnings.push('该实例关联的定时作业已一并清理')
    }
    return { warnings }
}

async function purgeInstance(instanceId) {
    let identity = await getInstanceIdentity(instanceId)
    if (!identity && hasTable('act_hi_procinst')) {
        const rows = await query('SELECT ID_ AS "id" FROM act_hi_procinst WHERE ID_ = ?', [instanceId])
        identity = rows.length > 0 ? rows[0] : null
    }
    if (!identity) throw new ApiError('流程实例不存在', 404)

    const historyTables = [
        'act_hi_identitylink',
        'act_hi_taskinst',
        'act_hi_actinst',
        'act_hi_varinst',
        'act_hi_detail',
        'act_hi_comment',
        'act_hi_attachment'
    ]

    await withTransaction(async (tx) => {
        await deleteRuntimeRows(tx, instanceId)
        for (const table of historyTables) {
            if (!hasTable(table)) continue
            await tx.execute(`DELETE FROM ${table} WHERE PROC_INST_ID_ = ?`, [instanceId])
        }
        if (hasTable('act_hi_procinst')) {
            await tx.execute('DELETE FROM act_hi_procinst WHERE ID_ = ?', [instanceId])
        }
    })
}

async function migrateInstance(instanceId, definitionId) {
    const identity = await getInstanceIdentity(instanceId)
    if (!identity) throw new ApiError('流程实例不存在', 404)
    if (identity.isFinished) throw new ApiError('流程实例已结束，无法变更流程版本')

    const definition = await getDefinition(definitionId)
    if (definition.key !== undefined && identity.procDefId) {
        const current = await getDefinition(identity.procDefId).catch(() => null)
        if (current && current.key !== definition.key) {
            throw new ApiError(`目标流程 Key 不一致（当前 ${current.key}，目标 ${definition.key}），无法迁移`)
        }
    }

    await withTransaction(async (tx) => {
        await tx.execute(
            'UPDATE act_ru_execution SET PROC_DEF_ID_ = ?, REV_ = REV_ + 1 WHERE PROC_INST_ID_ = ?',
            [definitionId, instanceId]
        )
        if (hasTable('act_ru_task')) {
            await tx.execute(
                'UPDATE act_ru_task SET PROC_DEF_ID_ = ?, REV_ = REV_ + 1 WHERE PROC_INST_ID_ = ?',
                [definitionId, instanceId]
            )
        }
    })

    return { definition }
}

// ==================== 流程变量 ====================

const BINARY_TYPES = ['bytearray', 'serializable']

function isBinaryType(type) {
    const normalized = String(type || '').toLowerCase()
    return BINARY_TYPES.some((item) => normalized.includes(item) || normalized === 'bytes')
}

function decodeVariable(row) {
    const type = String(row.type || 'string').toLowerCase()
    const raw = {
        text: row.text === undefined ? null : row.text,
        text2: row.text2 === undefined ? null : row.text2,
        long: row.long === undefined ? null : row.long,
        double: row.double === undefined ? null : row.double
    }
    let value = null
    let display = null

    if (isBinaryType(type) || (row.byteArrayId && raw.text === null && raw.long === null && raw.double === null)) {
        return { name: row.name, type, value: null, display: '[二进制数据]', editable: false, binary: true }
    }

    switch (type) {
        case 'string':
        case 'text':
            value = raw.text
            break
        case 'long':
        case 'integer':
            value = raw.long !== null ? Number(raw.long) : null
            break
        case 'double':
        case 'number':
            value = raw.double !== null ? Number(raw.double) : null
            break
        case 'boolean':
            if (raw.long !== null && raw.long !== undefined) {
                value = Number(raw.long) === 1
            } else if (raw.text !== null) {
                value = String(raw.text).toLowerCase() === 'true'
            }
            break
        case 'json':
            value = raw.text2 !== null ? raw.text2 : raw.text
            break
        default:
            value = raw.text2 !== null ? raw.text2 : raw.text
            if (value === null && raw.long !== null) value = Number(raw.long)
            if (value === null && raw.double !== null) value = Number(raw.double)
    }

    if (value === null || value === undefined) {
        display = raw.text !== null ? raw.text : null
    }
    return {
        name: row.name,
        type,
        value,
        display,
        editable: ['string', 'long', 'double', 'boolean', 'json'].includes(type),
        binary: false
    }
}

async function listVariables(instanceId) {
    if (hasTable('act_ru_variable')) {
        const rows = await query(
            `SELECT NAME_ AS "name", TYPE_ AS "type", TEXT_ AS "text", TEXT2_ AS "text2",
                    LONG_ AS "long", DOUBLE_ AS "double", BYTEARRAY_ID_ AS "byteArrayId",
                    EXECUTION_ID_ AS "executionId", REV_ AS "rev"
             FROM act_ru_variable
             WHERE PROC_INST_ID_ = ?
             ORDER BY NAME_ ASC`,
            [instanceId]
        )
        if (rows.length > 0) return rows.map(decodeVariable)
    }

    // 已结束实例的变量只在历史表中，取每个变量的最新记录用于展示
    if (!hasTable('act_hi_varinst')) return []
    const historyRows = await query(
        `SELECT NAME_ AS "name", VAR_TYPE_ AS "type", TEXT_ AS "text", TEXT2_ AS "text2",
                LONG_ AS "long", DOUBLE_ AS "double", BYTEARRAY_ID_ AS "byteArrayId"
         FROM act_hi_varinst
         WHERE PROC_INST_ID_ = ? AND NAME_ IS NOT NULL
         ORDER BY NAME_ ASC, COALESCE(LAST_UPDATED_TIME_, CREATE_TIME_) ASC, ID_ ASC`,
        [instanceId]
    )
    const latest = new Map()
    historyRows.forEach((row) => latest.set(row.name, row))
    return Array.from(latest.values()).map((row) => ({ ...decodeVariable(row), fromHistory: true }))
}

function buildVariableColumns(type, value) {
    const columns = { TEXT_: null, TEXT2_: null, LONG_: null, DOUBLE_: null }

    switch (type) {
        case 'string': {
            columns.TEXT_ = value === null || value === undefined ? null : String(value)
            if (columns.TEXT_ && columns.TEXT_.length > 4000) {
                throw new ApiError('字符串变量超过 4000 字符，Activiti 无法存储')
            }
            break
        }
        case 'long': {
            const number = Number(value)
            if (!Number.isFinite(number) || !Number.isInteger(number)) {
                throw new ApiError('Long 类型变量必须是整数')
            }
            columns.LONG_ = number
            break
        }
        case 'double': {
            const number = Number(value)
            if (!Number.isFinite(number)) {
                throw new ApiError('Double 类型变量必须是数字')
            }
            columns.DOUBLE_ = number
            break
        }
        case 'boolean': {
            columns.LONG_ = isTrue(value) || value === 'TRUE' ? 1 : 0
            break
        }
        case 'json': {
            let json = value
            if (typeof json !== 'string') json = JSON.stringify(json)
            try {
                JSON.parse(json)
            } catch (error) {
                throw new ApiError('JSON 类型变量不是合法的 JSON')
            }
            if (json.length > 4000) throw new ApiError('JSON 变量超过 4000 字符，Activiti 无法存储')
            columns.TEXT2_ = json
            break
        }
        default:
            throw new ApiError(`不支持的变量类型：${type}`)
    }
    return columns
}

async function saveVariable(instanceId, payload) {
    const name = requireString(payload.name, '变量名')
    const type = String(payload.type || 'string').toLowerCase()
    if (!['string', 'long', 'double', 'boolean', 'json'].includes(type)) {
        throw new ApiError(`不支持的变量类型：${type}`)
    }

    const columns = buildVariableColumns(type, payload.value)
    const existing = await query(
        'SELECT ID_ AS "id", TYPE_ AS "type", EXECUTION_ID_ AS "executionId" FROM act_ru_variable WHERE PROC_INST_ID_ = ? AND NAME_ = ?',
        [instanceId, name]
    )
    if (existing.some((row) => isBinaryType(row.type))) {
        throw new ApiError('二进制 / 序列化类型变量不允许修改')
    }

    const now = new Date()
    const historyAvailable = hasTable('act_hi_varinst')

    await withTransaction(async (tx) => {
        if (existing.length > 0) {
            await tx.execute(
                `UPDATE act_ru_variable
                 SET TYPE_ = ?, REV_ = REV_ + 1, TEXT_ = ?, TEXT2_ = ?, LONG_ = ?, DOUBLE_ = ?, BYTEARRAY_ID_ = NULL
                 WHERE PROC_INST_ID_ = ? AND NAME_ = ?`,
                [type, columns.TEXT_, columns.TEXT2_, columns.LONG_, columns.DOUBLE_, instanceId, name]
            )
            if (historyAvailable) {
                await tx.execute(
                    `UPDATE act_hi_varinst
                     SET VAR_TYPE_ = ?, TEXT_ = ?, TEXT2_ = ?, LONG_ = ?, DOUBLE_ = ?, BYTEARRAY_ID_ = NULL, LAST_UPDATED_TIME_ = ?
                     WHERE PROC_INST_ID_ = ? AND NAME_ = ?`,
                    [type, columns.TEXT_, columns.TEXT2_, columns.LONG_, columns.DOUBLE_, now, instanceId, name]
                )
            }
            return
        }

        const runtime = await tx.query('SELECT ID_ AS "id" FROM act_ru_execution WHERE ID_ = ?', [instanceId])
        if (runtime.length === 0) {
            throw new ApiError('流程实例不在运行中，无法新增变量')
        }

        const id = newId()
        const runtimeInsert = await buildInsert('act_ru_variable', [
            { name: 'ID_', param: id },
            { name: 'REV_', literal: '1' },
            { name: 'TYPE_', param: type },
            { name: 'NAME_', param: name },
            { name: 'EXECUTION_ID_', param: instanceId },
            { name: 'PROC_INST_ID_', param: instanceId },
            { name: 'TASK_ID_', literal: 'NULL' },
            { name: 'BYTEARRAY_ID_', literal: 'NULL' },
            { name: 'DOUBLE_', param: columns.DOUBLE_ },
            { name: 'LONG_', param: columns.LONG_ },
            { name: 'TEXT_', param: columns.TEXT_ },
            { name: 'TEXT2_', param: columns.TEXT2_ },
            { name: 'TENANT_ID_', literal: "''", optional: true }
        ])
        await tx.execute(runtimeInsert.sql, runtimeInsert.params)
        if (historyAvailable) {
            const historyInsert = await buildInsert('act_hi_varinst', [
                { name: 'ID_', param: id },
                { name: 'PROC_INST_ID_', param: instanceId },
                { name: 'EXECUTION_ID_', param: instanceId },
                { name: 'TASK_ID_', literal: 'NULL' },
                { name: 'NAME_', param: name },
                { name: 'VAR_TYPE_', param: type },
                { name: 'REV_', literal: '1' },
                { name: 'BYTEARRAY_ID_', literal: 'NULL' },
                { name: 'DOUBLE_', param: columns.DOUBLE_ },
                { name: 'LONG_', param: columns.LONG_ },
                { name: 'TEXT_', param: columns.TEXT_ },
                { name: 'TEXT2_', param: columns.TEXT2_ },
                { name: 'CREATE_TIME_', param: now },
                { name: 'LAST_UPDATED_TIME_', param: now },
                { name: 'TENANT_ID_', literal: "''", optional: true }
            ])
            await tx.execute(historyInsert.sql, historyInsert.params)
        }
    })
}

async function deleteVariable(instanceId, name) {
    await withTransaction(async (tx) => {
        await tx.execute('DELETE FROM act_ru_variable WHERE PROC_INST_ID_ = ? AND NAME_ = ?', [instanceId, name])
        if (hasTable('act_hi_varinst')) {
            await tx.execute('DELETE FROM act_hi_varinst WHERE PROC_INST_ID_ = ? AND NAME_ = ?', [instanceId, name])
        }
    })
}

// ==================== 审批意见（act_hi_comment） ====================

/**
 * 读取实例下的全部审批意见。
 * act_hi_comment 各库列不统一（标准结构没有 FLOW_STATE_，瀚高只有小写列名），
 * 因此按真实表结构拼 SELECT，缺列时返回 NULL 而不是让整个查询失败。
 */
async function listInstanceComments(instanceId) {
    if (!hasTable('act_hi_comment')) return []
    const present = await getColumns('act_hi_comment')
    const has = (name) => present.length === 0 || present.includes(name.toLowerCase())
    if (!has('PROC_INST_ID_')) return []

    const expr = (column, alias) => (has(column) ? `c.${column} AS "${alias}"` : `NULL AS "${alias}"`)
    const order = has('TIME_') ? 'c.TIME_ ASC, c.ID_ ASC' : 'c.ID_ ASC'
    const rows = await query(
        `SELECT ${expr('ID_', 'id')}, ${expr('TYPE_', 'type')}, ${expr('TIME_', 'time')},
                ${expr('USER_ID_', 'userId')}, ${expr('TASK_ID_', 'taskId')},
                ${expr('ACTION_', 'action')}, ${expr('MESSAGE_', 'message')},
                ${expr('FLOW_STATE_', 'flowState')}
         FROM act_hi_comment c
         WHERE c.PROC_INST_ID_ = ?
         ORDER BY ${order}`,
        [instanceId]
    )
    await ensureUsersFresh()
    return rows.map((row) => ({ ...row, userLabel: row.userId ? userLabel(row.userId) : null }))
}

/** Activiti 会把任务事件也写进 act_hi_comment（TYPE_ = 'event'），这些不是审批意见 */
function isOpinionComment(comment) {
    return String(comment.type || '').toLowerCase() !== 'event'
}

/**
 * 新增 / 修改 / 清空某个历史任务的审批意见。
 * message 为空表示删除该任务的审批意见（事件类记录保留）。
 */
async function saveTaskComment(taskId, payload, executor = null) {
    if (!hasTable('act_hi_comment')) {
        throw new ApiError('当前数据库没有审批意见表（act_hi_comment），无法保存审批意见', 400)
    }
    const raw = payload.comment === undefined || payload.comment === null ? '' : String(payload.comment)
    const message = raw.trim()
    if (message.length > 4000) throw new ApiError('审批意见过长，最多 4000 个字符')

    const run = executor ? executor.query.bind(executor) : query
    const runExecute = executor ? executor.execute.bind(executor) : execute

    const taskRows = await run(
        'SELECT ID_ AS "id", PROC_INST_ID_ AS "procInstId", ASSIGNEE_ AS "assignee" FROM act_hi_taskinst WHERE ID_ = ?',
        [taskId]
    )
    if (taskRows.length === 0) throw new ApiError('历史任务不存在', 404)
    const task = taskRows[0]

    const present = await getColumns('act_hi_comment')
    const has = (name) => present.length === 0 || present.includes(name.toLowerCase())
    const rows = await run(
        `SELECT c.ID_ AS "id", ${has('TYPE_') ? 'c.TYPE_' : 'NULL'} AS "type",
                ${has('TIME_') ? 'c.TIME_' : 'NULL'} AS "time"
         FROM act_hi_comment c WHERE c.TASK_ID_ = ?`,
        [taskId]
    )
    const latest = rows.filter(isOpinionComment).reduce((best, row) => {
        if (!best) return row
        const current = row.time ? new Date(row.time).getTime() : 0
        const previous = best.time ? new Date(best.time).getTime() : 0
        return current >= previous ? row : best
    }, null)

    if (message === '') {
        if (!latest) return { action: 'unchanged' }
        const typeFilter = has('TYPE_') ? " AND LOWER(COALESCE(TYPE_, 'comment')) <> 'event'" : ''
        await runExecute(`DELETE FROM act_hi_comment WHERE TASK_ID_ = ?${typeFilter}`, [taskId])
        return { action: 'deleted', id: latest.id }
    }

    if (latest) {
        // FULL_MSG_ 是 Activiti 的二进制副本，改了 MESSAGE_ 就必须清掉，否则两者不一致
        const clearFull = has('FULL_MSG_') ? ', FULL_MSG_ = NULL' : ''
        await runExecute(`UPDATE act_hi_comment SET MESSAGE_ = ?${clearFull} WHERE ID_ = ?`, [message, latest.id])
        return { action: 'updated', id: latest.id }
    }

    const insert = await buildInsert('act_hi_comment', [
        { name: 'ID_', param: newId() },
        { name: 'TYPE_', literal: "'comment'", optional: true },
        { name: 'TIME_', param: new Date() },
        { name: 'USER_ID_', param: payload.userId || task.assignee || null },
        { name: 'TASK_ID_', param: taskId },
        { name: 'PROC_INST_ID_', param: task.procInstId },
        { name: 'ACTION_', literal: "'AddComment'", optional: true },
        { name: 'MESSAGE_', param: message },
        { name: 'FULL_MSG_', literal: 'NULL', optional: true }
    ])
    await runExecute(insert.sql, insert.params)
    return { action: 'created' }
}

// ==================== 历史数据 ====================

async function listHistoryTasks(instanceId) {
    if (!hasTable('act_hi_taskinst')) return []
    await ensureUsersFresh()
    const rows = await query(
        `SELECT t.ID_ AS "id", t.NAME_ AS "name", t.ASSIGNEE_ AS "assignee", t.OWNER_ AS "owner",
                t.START_TIME_ AS "startTime", t.END_TIME_ AS "endTime", t.DURATION_ AS "duration",
                t.DELETE_REASON_ AS "deleteReason", t.TASK_DEF_KEY_ AS "taskDefKey",
                t.PROC_INST_ID_ AS "procInstId", t.EXECUTION_ID_ AS "executionId", t.PRIORITY_ AS "priority"
         FROM act_hi_taskinst t
         WHERE t.PROC_INST_ID_ = ?
         ORDER BY t.START_TIME_ ASC, t.ID_ ASC`,
        [instanceId]
    )

    const byTask = new Map()
    for (const comment of await listInstanceComments(instanceId)) {
        if (!comment.taskId) continue
        const key = String(comment.taskId)
        if (!byTask.has(key)) byTask.set(key, [])
        byTask.get(key).push(comment)
    }

    return rows.map((row) => {
        const all = byTask.get(String(row.id)) || []
        const opinions = all.filter(isOpinionComment)
        const latest = opinions.length > 0 ? opinions[opinions.length - 1] : null
        return {
            ...row,
            assigneeLabel: row.assignee ? userLabel(row.assignee) : null,
            comment: latest ? latest.message : null,
            commentId: latest ? latest.id : null,
            commentTime: latest ? latest.time : null,
            commentUser: latest ? latest.userId : null,
            commentUserLabel: latest ? latest.userLabel : null,
            commentCount: opinions.length,
            comments: all
        }
    })
}

async function listActivities(instanceId) {
    if (!hasTable('act_hi_actinst')) return []
    await ensureUsersFresh()
    const rows = await query(
        `SELECT a.ID_ AS "id", a.ACT_ID_ AS "activityId", a.ACT_NAME_ AS "activityName", a.ACT_TYPE_ AS "activityType",
                a.ASSIGNEE_ AS "assignee", a.START_TIME_ AS "startTime", a.END_TIME_ AS "endTime",
                a.DURATION_ AS "duration", a.DELETE_REASON_ AS "deleteReason", a.TASK_ID_ AS "taskId"
         FROM act_hi_actinst a
         WHERE a.PROC_INST_ID_ = ?
         ORDER BY a.START_TIME_ ASC, a.ID_ ASC`,
        [instanceId]
    )
    return rows.map((row) => ({ ...row, assigneeLabel: row.assignee ? userLabel(row.assignee) : null }))
}

async function updateHistoryTask(taskId, payload) {
    if (!hasTable('act_hi_taskinst')) throw new ApiError('当前数据库没有历史任务表')
    const rows = await query(
        'SELECT ID_ AS "id", NAME_ AS "name", ASSIGNEE_ AS "assignee", START_TIME_ AS "startTime", END_TIME_ AS "endTime", DELETE_REASON_ AS "deleteReason", PROC_INST_ID_ AS "procInstId" FROM act_hi_taskinst WHERE ID_ = ?',
        [taskId]
    )
    if (rows.length === 0) throw new ApiError('历史任务不存在', 404)
    const task = rows[0]

    const name = payload.name === undefined ? task.name : requireString(payload.name, '任务名称')
    const assignee = payload.assignee === undefined ? task.assignee : (payload.assignee || null)
    // 库里的时间经过 convertRow 可能是 ISO 字符串，必须先转成 Date 再算时长
    const rawEndTime = payload.endTime === undefined ? task.endTime : payload.endTime
    const endTime = rawEndTime ? new Date(rawEndTime) : null
    // 未传删除原因时保留原值，避免“只改审批意见”把已有原因清掉
    const deleteReason = payload.deleteReason === undefined
        ? (task.deleteReason || null)
        : (String(payload.deleteReason).trim().slice(0, 4000) || null)

    if (endTime && Number.isNaN(endTime.getTime())) throw new ApiError('审批时间格式不正确')
    const startTime = task.startTime ? new Date(task.startTime) : null
    const duration = startTime && endTime ? Math.max(0, endTime.getTime() - startTime.getTime()) : null

    return await withTransaction(async (tx) => {
        await tx.execute(
            'UPDATE act_hi_taskinst SET NAME_ = ?, ASSIGNEE_ = ?, END_TIME_ = ?, DURATION_ = ?, DELETE_REASON_ = ? WHERE ID_ = ?',
            [name, assignee, endTime, duration, deleteReason, taskId]
        )
        if (hasTable('act_hi_identitylink')) {
            await tx.execute(
                `UPDATE act_hi_identitylink SET USER_ID_ = ? WHERE TASK_ID_ = ? AND TYPE_ = 'assignee'`,
                [assignee, taskId]
            )
        }
        if (hasTable('act_hi_actinst')) {
            await tx.execute('UPDATE act_hi_actinst SET ASSIGNEE_ = ? WHERE TASK_ID_ = ?', [assignee, taskId])
        }
        if (payload.comment !== undefined) {
            return await saveTaskComment(
                taskId,
                { comment: payload.comment, userId: payload.commentUserId || assignee },
                tx
            )
        }
        return { action: 'unchanged' }
    })
}

async function deleteHistoryTask(taskId) {
    if (!hasTable('act_hi_taskinst')) throw new ApiError('当前数据库没有历史任务表')
    const rows = await query(
        'SELECT ID_ AS "id", END_TIME_ AS "endTime" FROM act_hi_taskinst WHERE ID_ = ?',
        [taskId]
    )
    if (rows.length === 0) throw new ApiError('历史任务不存在', 404)
    // 运行中的任务对应流程当前节点,删除历史记录会破坏运行态,直接拒绝
    if (!rows[0].endTime) throw new ApiError('该任务正在运行中,不能删除')

    await withTransaction(async (tx) => {
        // 先按 TASK_ID_ 清理关联的候选人、审批意见与流转记录,再删任务本身
        if (hasTable('act_hi_identitylink')) {
            await tx.execute('DELETE FROM act_hi_identitylink WHERE TASK_ID_ = ?', [taskId])
        }
        if (hasTable('act_hi_comment')) {
            await tx.execute('DELETE FROM act_hi_comment WHERE TASK_ID_ = ?', [taskId])
        }
        if (hasTable('act_hi_actinst')) {
            await tx.execute('DELETE FROM act_hi_actinst WHERE TASK_ID_ = ?', [taskId])
        }
        await tx.execute('DELETE FROM act_hi_taskinst WHERE ID_ = ?', [taskId])
    })
    return { action: 'deleted' }
}

// ==================== 任务 ====================

async function listTasks(options) {
    const { page, size, offset } = parsePaging(options)
    const keyword = (options.keyword || '').trim()

    const conditions = []
    const params = []

    if (keyword) {
        const kw = `%${keyword}%`
        conditions.push(
            `(t.NAME_ ${likeOp()} ? OR t.ASSIGNEE_ ${likeOp()} ? OR t.ID_ ${likeOp()} ? OR t.PROC_INST_ID_ ${likeOp()} ? OR pd.NAME_ ${likeOp()} ?)`
        )
        params.push(kw, kw, kw, kw, kw)
    }
    if (options.assignee === 'unassigned') {
        conditions.push("(t.ASSIGNEE_ IS NULL OR t.ASSIGNEE_ = '')")
    } else if (options.assignee) {
        conditions.push('t.ASSIGNEE_ = ?')
        params.push(options.assignee)
    }
    if (options.procDefKey) {
        conditions.push('pd.KEY_ = ?')
        params.push(options.procDefKey)
    }
    if (options.state === 'suspended') {
        conditions.push('t.SUSPENSION_STATE_ = 2')
    } else if (options.state === 'active') {
        conditions.push('t.SUSPENSION_STATE_ = 1')
    }

    const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''

    const rows = await query(
        `SELECT t.ID_ AS "id", t.NAME_ AS "name", t.TASK_DEF_KEY_ AS "taskDefKey", t.ASSIGNEE_ AS "assignee",
                t.CREATE_TIME_ AS "createTime", t.DUE_DATE_ AS "dueDate", t.PRIORITY_ AS "priority",
                t.SUSPENSION_STATE_ AS "suspensionState", t.PROC_INST_ID_ AS "procInstId",
                t.PROC_DEF_ID_ AS "procDefId", pd.NAME_ AS "procDefName", pd.KEY_ AS "procDefKey",
                pi.BUSINESS_KEY_ AS "businessKey", pi.START_USER_ID_ AS "startUserId"
         FROM act_ru_task t
         LEFT JOIN act_re_procdef pd ON t.PROC_DEF_ID_ = pd.ID_
         LEFT JOIN act_ru_execution pi ON pi.ID_ = t.PROC_INST_ID_
         ${whereSql}
         ORDER BY t.CREATE_TIME_ DESC
         LIMIT ${size} OFFSET ${offset}`,
        params
    )

    const totalRows = await query(
        `SELECT COUNT(*) AS "total"
         FROM act_ru_task t
         LEFT JOIN act_re_procdef pd ON t.PROC_DEF_ID_ = pd.ID_
         ${whereSql}`,
        params
    )

    await ensureUsersFresh()
    await attachTaskCandidates(rows)
    for (const row of rows) {
        row.startUserLabel = userLabel(row.startUserId)
    }

    return { items: rows, total: Number(totalRows[0]?.total || 0), page, size }
}

async function setTaskAssignee(taskId, assignee) {
    const rows = await query('SELECT ID_ AS "id" FROM act_ru_task WHERE ID_ = ?', [taskId])
    if (rows.length === 0) throw new ApiError('任务不存在或已结束', 404)

    await withTransaction(async (tx) => {
        await tx.execute(
            'UPDATE act_ru_task SET ASSIGNEE_ = ?, CLAIM_TIME_ = ?, REV_ = REV_ + 1 WHERE ID_ = ?',
            [assignee || null, assignee ? new Date() : null, taskId]
        )
        if (!hasTable('act_ru_identitylink')) return

        if (!assignee) {
            await tx.execute(`DELETE FROM act_ru_identitylink WHERE TASK_ID_ = ? AND TYPE_ = 'assignee'`, [taskId])
            return
        }

        const existing = await tx.query(
            `SELECT ID_ AS "id" FROM act_ru_identitylink WHERE TASK_ID_ = ? AND TYPE_ = 'assignee'`,
            [taskId]
        )
        if (existing.length > 0) {
            await tx.execute('UPDATE act_ru_identitylink SET USER_ID_ = ? WHERE ID_ = ?', [assignee, existing[0].id])
        } else {
            await tx.execute(
                `INSERT INTO act_ru_identitylink (ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_, PROC_DEF_ID_)
                 SELECT ?, 1, 'assignee', ?, NULL, t.ID_, t.PROC_INST_ID_, t.PROC_DEF_ID_ FROM act_ru_task t WHERE t.ID_ = ?`,
                [newId(), assignee, taskId]
            )
        }
    })
}

async function setTaskSuspension(taskId, suspended) {
    const rows = await query('SELECT ID_ AS "id" FROM act_ru_task WHERE ID_ = ?', [taskId])
    if (rows.length === 0) throw new ApiError('任务不存在或已结束', 404)
    await execute('UPDATE act_ru_task SET SUSPENSION_STATE_ = ?, REV_ = REV_ + 1 WHERE ID_ = ?', [suspended ? 2 : 1, taskId])
}

async function listTaskIdentityLinks(taskId) {
    if (!hasTable('act_ru_identitylink')) return []
    await ensureUsersFresh()
    const rows = await query(
        `SELECT il.ID_ AS "id", il.TYPE_ AS "type", il.USER_ID_ AS "userId", il.GROUP_ID_ AS "groupId"
         FROM act_ru_identitylink il
         WHERE il.TASK_ID_ = ? AND (il.USER_ID_ IS NOT NULL OR il.GROUP_ID_ IS NOT NULL)
         ORDER BY il.TYPE_ ASC`,
        [taskId]
    )
    return rows.map((row) => ({ ...row, label: row.userId ? userLabel(row.userId) : `组:${row.groupId}` }))
}

async function addTaskIdentityLink(taskId, userId, type) {
    const rows = await query(
        'SELECT ID_ AS "id", PROC_INST_ID_ AS "procInstId", PROC_DEF_ID_ AS "procDefId" FROM act_ru_task WHERE ID_ = ?',
        [taskId]
    )
    if (rows.length === 0) throw new ApiError('任务不存在或已结束', 404)

    const linkType = type === 'participant' ? 'participant' : 'candidate'
    const exists = await query(
        'SELECT ID_ AS "id" FROM act_ru_identitylink WHERE TASK_ID_ = ? AND USER_ID_ = ? AND TYPE_ = ?',
        [taskId, userId, linkType]
    )
    if (exists.length > 0) throw new ApiError('该用户已存在相同的身份关联')

    await execute(
        `INSERT INTO act_ru_identitylink (ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_, PROC_DEF_ID_)
         VALUES (?, 1, ?, ?, NULL, ?, ?, ?)`,
        [newId(), linkType, userId, taskId, rows[0].procInstId, rows[0].procDefId]
    )
}

async function removeTaskIdentityLink(taskId, userId, groupId, type) {
    const conditions = ['TASK_ID_ = ?']
    const params = [taskId]
    if (userId) {
        conditions.push('USER_ID_ = ?')
        params.push(userId)
    }
    if (groupId) {
        conditions.push('GROUP_ID_ = ?')
        params.push(groupId)
    }
    if (type) {
        conditions.push('TYPE_ = ?')
        params.push(type)
    }
    if (conditions.length === 1) throw new ApiError('请指定要删除的用户或组')
    await execute(`DELETE FROM act_ru_identitylink WHERE ${conditions.join(' AND ')}`, params)
}

// ==================== 跳转 / 回退 ====================

async function resolveNodeAssignment(definitionId, activityId) {
    const xml = await readDefinitionXml(definitionId).catch(() => '')
    const nodes = parseBpmnNodes(xml)
    const node = nodes.find((item) => item.id === activityId) || null
    if (!node) return { node: null, assignee: null, candidates: [], warnings: [] }

    const warnings = []
    let assignee = null
    if (node.assignee) {
        if (isExpression(node.assignee)) {
            warnings.push(`节点审批人为表达式 ${node.assignee}，未自动分配`)
        } else {
            assignee = node.assignee
        }
    }

    const candidates = []
    for (const userId of splitList(node.candidateUsers)) {
        candidates.push({ userId, groupId: null })
    }
    for (const groupCode of splitList(node.candidateGroups)) {
        const users = await resolveUsersByRoles([groupCode])
        if (users.length === 0) {
            warnings.push(`候选组 ${groupCode} 未解析到用户，已保留为候选组`)
            candidates.push({ userId: null, groupId: groupCode })
        } else {
            users.forEach((user) => candidates.push({ userId: user.id, groupId: null }))
        }
    }
    return { node, assignee, candidates, warnings }
}

async function ensureExecution(tx, instanceId, proc, executionId) {
    if (!executionId || executionId === instanceId) return instanceId
    const existing = await tx.query('SELECT ID_ AS "id" FROM act_ru_execution WHERE ID_ = ?', [executionId])
    if (existing.length > 0) return executionId

    const insert = await buildInsert('act_ru_execution', [
        { name: 'ID_', param: executionId },
        { name: 'REV_', literal: '1' },
        { name: 'PROC_INST_ID_', param: instanceId },
        { name: 'BUSINESS_KEY_', param: proc.businessKey },
        { name: 'PARENT_ID_', param: instanceId },
        { name: 'PROC_DEF_ID_', param: proc.procDefId },
        { name: 'ACT_ID_', param: proc.activityId || null },
        { name: 'IS_ACTIVE_', literal: boolLiteral(true) },
        { name: 'IS_CONCURRENT_', literal: boolLiteral(false) },
        { name: 'IS_SCOPE_', literal: boolLiteral(false) },
        { name: 'IS_EVENT_SCOPE_', literal: boolLiteral(false) },
        { name: 'IS_MI_ROOT_', literal: boolLiteral(false) },
        { name: 'SUSPENSION_STATE_', literal: '1' },
        { name: 'TENANT_ID_', param: proc.tenantId || '', optional: true },
        { name: 'START_TIME_', param: proc.startTime },
        { name: 'START_USER_ID_', param: proc.startUserId },
        { name: 'IS_COUNT_ENABLED_', literal: boolLiteral(true) }
    ])
    await tx.execute(insert.sql, insert.params)
    return executionId
}

async function resetRuntime(tx, instanceId, proc, activityId) {
    // 1. 身份关联（可能只带 TASK_ID_，必须按任务一并清理）
    if (hasTable('act_ru_identitylink')) {
        if (hasTable('act_ru_task')) {
            await tx.execute(
                `DELETE FROM act_ru_identitylink
                 WHERE PROC_INST_ID_ = ? OR TASK_ID_ IN (SELECT ID_ FROM act_ru_task WHERE PROC_INST_ID_ = ?)`,
                [instanceId, instanceId]
            )
        } else {
            await tx.execute('DELETE FROM act_ru_identitylink WHERE PROC_INST_ID_ = ?', [instanceId])
        }
    }

    // 2. 当前任务
    if (hasTable('act_ru_task')) {
        await tx.execute('DELETE FROM act_ru_task WHERE PROC_INST_ID_ = ?', [instanceId])
    }

    // 3. 变量保留并挂到根执行实例，避免丢失运行时变量或触发外键
    if (hasTable('act_ru_variable')) {
        await tx.execute(
            'UPDATE act_ru_variable SET EXECUTION_ID_ = ?, TASK_ID_ = NULL WHERE PROC_INST_ID_ = ?',
            [instanceId, instanceId]
        )
    }

    // 4. 作业与事件订阅
    for (const table of ['act_ru_job', 'act_ru_timer_job', 'act_ru_suspended_job', 'act_ru_deadletter_job']) {
        if (!hasTable(table)) continue
        await tx.execute(`DELETE FROM ${table} WHERE PROCESS_INSTANCE_ID_ = ?`, [instanceId])
    }
    if (hasTable('act_ru_event_subscr')) {
        await tx.execute(
            `DELETE FROM act_ru_event_subscr
             WHERE PROC_INST_ID_ = ? OR EXECUTION_ID_ IN (SELECT ID_ FROM act_ru_execution WHERE PROC_INST_ID_ = ?)`,
            [instanceId, instanceId]
        )
    }

    // 5. 子执行实例（并行分支 / 多实例被合并）
    if (hasTable('act_ru_execution')) {
        await tx.execute('DELETE FROM act_ru_execution WHERE PROC_INST_ID_ = ? AND ID_ <> ?', [instanceId, instanceId])
        const root = await tx.query('SELECT ID_ AS "id" FROM act_ru_execution WHERE ID_ = ?', [instanceId])
        if (root.length > 0) {
            await tx.execute(
                `UPDATE act_ru_execution
                 SET REV_ = REV_ + 1, ACT_ID_ = ?, PROC_DEF_ID_ = ?, BUSINESS_KEY_ = ?, START_TIME_ = ?,
                     START_USER_ID_ = ?, IS_ACTIVE_ = ${boolLiteral(true)}, IS_CONCURRENT_ = ${boolLiteral(false)},
                     IS_SCOPE_ = ${boolLiteral(true)}, IS_EVENT_SCOPE_ = ${boolLiteral(false)}, SUSPENSION_STATE_ = 1
                 WHERE ID_ = ?`,
                [activityId, proc.procDefId, proc.businessKey, proc.startTime, proc.startUserId, instanceId]
            )
        } else {
            const insert = await buildInsert('act_ru_execution', [
                { name: 'ID_', param: instanceId },
                { name: 'REV_', literal: '1' },
                { name: 'PROC_INST_ID_', param: instanceId },
                { name: 'BUSINESS_KEY_', param: proc.businessKey },
                { name: 'PARENT_ID_', literal: 'NULL' },
                { name: 'PROC_DEF_ID_', param: proc.procDefId },
                { name: 'ACT_ID_', param: activityId },
                { name: 'IS_ACTIVE_', literal: boolLiteral(true) },
                { name: 'IS_CONCURRENT_', literal: boolLiteral(false) },
                { name: 'IS_SCOPE_', literal: boolLiteral(true) },
                { name: 'IS_EVENT_SCOPE_', literal: boolLiteral(false) },
                { name: 'IS_MI_ROOT_', literal: boolLiteral(false) },
                { name: 'SUSPENSION_STATE_', literal: '1' },
                { name: 'TENANT_ID_', param: proc.tenantId || '', optional: true },
                { name: 'START_TIME_', param: proc.startTime },
                { name: 'START_USER_ID_', param: proc.startUserId },
                { name: 'IS_COUNT_ENABLED_', literal: boolLiteral(true) }
            ])
            await tx.execute(insert.sql, insert.params)
        }
    }
}

async function insertRuntimeTask(tx, task) {
    const insert = await buildInsert('act_ru_task', [
        { name: 'ID_', param: task.id },
        { name: 'REV_', literal: '1' },
        { name: 'EXECUTION_ID_', param: task.executionId },
        { name: 'PROC_INST_ID_', param: task.instanceId },
        { name: 'PROC_DEF_ID_', param: task.procDefId },
        { name: 'NAME_', param: task.name || null },
        { name: 'PARENT_TASK_ID_', param: task.parentTaskId || null },
        { name: 'DESCRIPTION_', param: task.description || null },
        { name: 'TASK_DEF_KEY_', param: task.taskDefKey || null },
        { name: 'OWNER_', param: task.owner || null },
        { name: 'ASSIGNEE_', param: task.assignee || null },
        { name: 'DELEGATION_', literal: 'NULL' },
        { name: 'PRIORITY_', param: task.priority || 50 },
        { name: 'CREATE_TIME_', param: new Date() },
        { name: 'DUE_DATE_', param: task.dueDate || null },
        { name: 'CATEGORY_', param: task.category || null },
        { name: 'SUSPENSION_STATE_', literal: '1' },
        { name: 'TENANT_ID_', param: task.tenantId || '', optional: true },
        { name: 'FORM_KEY_', param: task.formKey || null },
        { name: 'CLAIM_TIME_', literal: 'NULL' }
    ])
    await tx.execute(insert.sql, insert.params)
}

async function insertCandidateLinks(tx, instanceId, taskId, candidates) {
    if (!hasTable('act_ru_identitylink') || !candidates || candidates.length === 0) return
    const inserted = new Set()
    for (const candidate of candidates) {
        const key = `${candidate.userId || ''}|${candidate.groupId || ''}`
        if (inserted.has(key)) continue
        inserted.add(key)
        await tx.execute(
            `INSERT INTO act_ru_identitylink (ID_, REV_, TYPE_, USER_ID_, GROUP_ID_, TASK_ID_, PROC_INST_ID_, PROC_DEF_ID_)
             VALUES (?, 1, 'candidate', ?, ?, ?, ?, NULL)`,
            [newId(), candidate.userId || null, candidate.groupId || null, taskId, instanceId]
        )
    }
}

async function restoreVariables(tx, instanceId, options = {}) {
    if (!hasTable('act_hi_varinst') || !hasTable('act_ru_variable')) return { restored: 0, kept: 0 }

    const existingRows = await tx.query(
        'SELECT NAME_ AS "name" FROM act_ru_variable WHERE PROC_INST_ID_ = ?',
        [instanceId]
    )
    const existing = new Set(existingRows.map((row) => row.name))
    if (!options.skipExisting) existing.clear()

    const rows = await tx.query(
        `SELECT ID_ AS "id", NAME_ AS "name", VAR_TYPE_ AS "varType", TEXT_ AS "text", TEXT2_ AS "text2",
                LONG_ AS "long", DOUBLE_ AS "double", BYTEARRAY_ID_ AS "byteArrayId",
                TASK_ID_ AS "taskId", REV_ AS "rev"
         FROM act_hi_varinst
         WHERE PROC_INST_ID_ = ? AND NAME_ IS NOT NULL`,
        [instanceId]
    )

    const latest = new Map()
    for (const row of rows) latest.set(row.name, row)

    let restored = 0
    let kept = 0
    for (const row of latest.values()) {
        if (existing.has(row.name)) {
            kept += 1
            continue
        }
        const insert = await buildInsert('act_ru_variable', [
            { name: 'ID_', param: row.id || newId() },
            { name: 'REV_', param: row.rev || 1 },
            { name: 'TYPE_', param: row.varType || 'string' },
            { name: 'NAME_', param: row.name },
            { name: 'EXECUTION_ID_', param: instanceId },
            { name: 'PROC_INST_ID_', param: instanceId },
            { name: 'TASK_ID_', param: row.taskId || null },
            { name: 'BYTEARRAY_ID_', param: row.byteArrayId || null },
            { name: 'DOUBLE_', param: row.double },
            { name: 'LONG_', param: row.long },
            { name: 'TEXT_', param: row.text },
            { name: 'TEXT2_', param: row.text2 },
            { name: 'TENANT_ID_', literal: "''", optional: true }
        ])
        await tx.execute(insert.sql, insert.params)
        restored += 1
    }
    return { restored, kept }
}

async function deleteHistoryAfter(tx, instanceId, targetTaskId, targetStartTime) {
    if (!hasTable('act_hi_taskinst')) return
    const allTasks = await tx.query(
        'SELECT ID_ AS "id", START_TIME_ AS "startTime" FROM act_hi_taskinst WHERE PROC_INST_ID_ = ? ORDER BY START_TIME_ ASC, ID_ ASC',
        [instanceId]
    )
    const index = allTasks.findIndex((row) => row.id === targetTaskId)
    const toDelete = index >= 0 ? allTasks.slice(index + 1).map((row) => row.id) : []

    if (toDelete.length > 0) {
        const marks = placeholders(toDelete.length)
        if (hasTable('act_hi_identitylink')) {
            await tx.execute(`DELETE FROM act_hi_identitylink WHERE TASK_ID_ IN (${marks})`, toDelete)
        }
        if (hasTable('act_hi_actinst')) {
            await tx.execute(`DELETE FROM act_hi_actinst WHERE TASK_ID_ IN (${marks})`, toDelete)
        }
        if (hasTable('act_hi_comment')) {
            await tx.execute(`DELETE FROM act_hi_comment WHERE TASK_ID_ IN (${marks})`, toDelete)
        }
        await tx.execute(`DELETE FROM act_hi_taskinst WHERE ID_ IN (${marks})`, toDelete)
    }

    if (hasTable('act_hi_actinst') && targetStartTime) {
        await tx.execute(
            'DELETE FROM act_hi_actinst WHERE PROC_INST_ID_ = ? AND START_TIME_ > ? AND TASK_ID_ IS NULL',
            [instanceId, targetStartTime]
        )
    }
}

async function reopenHistory(tx, instanceId, taskId, assignee) {
    if (hasTable('act_hi_taskinst')) {
        await tx.execute(
            'UPDATE act_hi_taskinst SET END_TIME_ = NULL, DURATION_ = NULL, DELETE_REASON_ = NULL, ASSIGNEE_ = ? WHERE ID_ = ?',
            [assignee || null, taskId]
        )
    }
    if (hasTable('act_hi_actinst')) {
        await tx.execute(
            'UPDATE act_hi_actinst SET END_TIME_ = NULL, DURATION_ = NULL, DELETE_REASON_ = NULL, ASSIGNEE_ = ? WHERE TASK_ID_ = ?',
            [assignee || null, taskId]
        )
    }
    if (hasTable('act_hi_procinst')) {
        await tx.execute(
            'UPDATE act_hi_procinst SET END_TIME_ = NULL, DURATION_ = NULL, DELETE_REASON_ = NULL, END_ACT_ID_ = NULL WHERE ID_ = ?',
            [instanceId]
        )
    }
}

async function historyCandidates(taskId) {
    if (!hasTable('act_hi_identitylink')) return []
    const rows = await query(
        `SELECT USER_ID_ AS "userId", GROUP_ID_ AS "groupId" FROM act_hi_identitylink
         WHERE TASK_ID_ = ? AND TYPE_ = 'candidate' AND (USER_ID_ IS NOT NULL OR GROUP_ID_ IS NOT NULL)`,
        [taskId]
    )
    return rows
}

async function jumpToHistoryTask(instanceId, targetTaskId) {
    if (!hasTable('act_hi_taskinst')) throw new ApiError('当前数据库没有历史任务表')

    const identity = await getInstanceIdentity(instanceId)
    if (!identity) throw new ApiError('流程实例不存在', 404)

    const rows = await query(
        `SELECT t.ID_ AS "id", t.NAME_ AS "name", t.TASK_DEF_KEY_ AS "taskDefKey", t.PROC_DEF_ID_ AS "procDefId",
                t.START_TIME_ AS "startTime", t.ASSIGNEE_ AS "assignee", t.PRIORITY_ AS "priority",
                t.FORM_KEY_ AS "formKey", t.PARENT_TASK_ID_ AS "parentTaskId", t.DESCRIPTION_ AS "description",
                t.OWNER_ AS "owner", t.CATEGORY_ AS "category", t.TENANT_ID_ AS "tenantId",
                t.EXECUTION_ID_ AS "executionId", t.DUE_DATE_ AS "dueDate"
         FROM act_hi_taskinst t
         WHERE t.ID_ = ? AND t.PROC_INST_ID_ = ?`,
        [targetTaskId, instanceId]
    )
    if (rows.length === 0) throw new ApiError('历史任务不存在', 404)
    const task = rows[0]

    let activityId = task.taskDefKey
    if (hasTable('act_hi_actinst')) {
        const actRows = await query(
            'SELECT ACT_ID_ AS "activityId" FROM act_hi_actinst WHERE TASK_ID_ = ? AND ACT_ID_ IS NOT NULL',
            [targetTaskId]
        )
        if (actRows.length > 0) activityId = actRows[0].activityId
    }
    if (!activityId) throw new ApiError('无法确定目标任务对应的流程节点')

    const proc = {
        procDefId: task.procDefId || identity.procDefId,
        businessKey: identity.businessKey,
        startTime: identity.startTime,
        startUserId: identity.startUserId,
        tenantId: task.tenantId || identity.tenantId,
        activityId
    }

    let candidates = await historyCandidates(targetTaskId)
    let assignee = task.assignee || null
    const warnings = []
    if (!assignee && candidates.length === 0) {
        const resolved = await resolveNodeAssignment(proc.procDefId, activityId)
        assignee = resolved.assignee
        candidates = resolved.candidates
        warnings.push(...resolved.warnings)
    }

    const taskId = targetTaskId
    let variableResult = { restored: 0, kept: 0 }

    await withTransaction(async (tx) => {
        await resetRuntime(tx, instanceId, proc, activityId)
        const executionId = await ensureExecution(tx, instanceId, proc, task.executionId)
        await insertRuntimeTask(tx, {
            id: taskId,
            instanceId,
            executionId,
            procDefId: proc.procDefId,
            name: task.name,
            taskDefKey: task.taskDefKey || activityId,
            assignee,
            owner: task.owner,
            description: task.description,
            priority: task.priority,
            dueDate: task.dueDate,
            formKey: task.formKey,
            parentTaskId: task.parentTaskId,
            category: task.category,
            tenantId: proc.tenantId
        })
        await insertCandidateLinks(tx, instanceId, taskId, candidates)
        variableResult = await restoreVariables(tx, instanceId, { skipExisting: true })
        await deleteHistoryAfter(tx, instanceId, taskId, task.startTime)
        await reopenHistory(tx, instanceId, taskId, assignee)
    })

    if (variableResult.restored > 0) {
        warnings.push(`已从历史变量补充恢复 ${variableResult.restored} 个流程变量`)
    }
    if (variableResult.kept > 0) {
        warnings.push(`保留了当前运行中的 ${variableResult.kept} 个流程变量`)
    }
    return { taskId, activityId, assignee, restoredVariables: variableResult.restored, warnings }
}

async function jumpToActivity(instanceId, activityId) {
    const identity = await getInstanceIdentity(instanceId)
    if (!identity) throw new ApiError('流程实例不存在', 404)
    if (identity.isFinished) {
        // 已结束实例也允许重新激活到指定节点
        identity.isFinished = false
    }

    const definitionId = identity.procDefId
    if (!definitionId) throw new ApiError('流程实例缺少流程定义信息')
    const xml = await readDefinitionXml(definitionId).catch(() => '')
    const node = parseBpmnNodes(xml).find((item) => item.id === activityId)
    if (!node) throw new ApiError('流程定义中找不到该节点，请刷新流程图后重试')
    if (node.type !== 'userTask') throw new ApiError('仅支持跳转到用户任务（userTask）节点')

    const resolved = await resolveNodeAssignment(definitionId, activityId)
    const warnings = [...resolved.warnings]
    const proc = {
        procDefId: definitionId,
        businessKey: identity.businessKey,
        startTime: identity.startTime,
        startUserId: identity.startUserId,
        tenantId: identity.tenantId,
        activityId
    }

    const taskId = newId()
    const assignment = { assignee: resolved.assignee, candidates: resolved.candidates }

    await withTransaction(async (tx) => {
        const runtime = await tx.query('SELECT ID_ AS "id" FROM act_ru_execution WHERE ID_ = ?', [instanceId])
        if (runtime.length > 0) {
            if (hasTable('act_ru_identitylink')) {
                await tx.execute('DELETE FROM act_ru_identitylink WHERE PROC_INST_ID_ = ?', [instanceId])
            }
            await tx.execute('DELETE FROM act_ru_task WHERE PROC_INST_ID_ = ?', [instanceId])
            await tx.execute('DELETE FROM act_ru_execution WHERE PROC_INST_ID_ = ? AND ID_ <> ?', [instanceId, instanceId])
            await tx.execute(
                `UPDATE act_ru_execution SET REV_ = REV_ + 1, ACT_ID_ = ?, IS_ACTIVE_ = ${boolLiteral(true)},
                 SUSPENSION_STATE_ = 1, PROC_DEF_ID_ = ? WHERE ID_ = ?`,
                [activityId, definitionId, instanceId]
            )
        } else {
            await resetRuntime(tx, instanceId, proc, activityId)
            await restoreVariables(tx, instanceId, { skipExisting: false })
        }

        await insertRuntimeTask(tx, {
            id: taskId,
            instanceId,
            executionId: instanceId,
            procDefId: definitionId,
            name: node.name || activityId,
            taskDefKey: activityId,
            assignee: assignment.assignee,
            owner: null,
            description: null,
            priority: 50,
            tenantId: proc.tenantId
        })
        await insertCandidateLinks(tx, instanceId, taskId, assignment.candidates)

        const now = new Date()
        if (hasTable('act_hi_taskinst')) {
            const historyTask = await buildInsert('act_hi_taskinst', [
                { name: 'ID_', param: taskId },
                { name: 'PROC_DEF_ID_', param: definitionId },
                { name: 'TASK_DEF_KEY_', param: activityId },
                { name: 'PROC_INST_ID_', param: instanceId },
                { name: 'EXECUTION_ID_', param: instanceId },
                { name: 'NAME_', param: node.name || activityId },
                { name: 'ASSIGNEE_', param: assignment.assignee },
                { name: 'START_TIME_', param: now },
                { name: 'PRIORITY_', literal: '50' },
                { name: 'TENANT_ID_', param: proc.tenantId || '', optional: true }
            ])
            await tx.execute(historyTask.sql, historyTask.params)
        }
        if (hasTable('act_hi_actinst')) {
            const historyActivity = await buildInsert('act_hi_actinst', [
                { name: 'ID_', param: newId() },
                { name: 'PROC_DEF_ID_', param: definitionId },
                { name: 'PROC_INST_ID_', param: instanceId },
                { name: 'EXECUTION_ID_', param: instanceId },
                { name: 'ACT_ID_', param: activityId },
                { name: 'TASK_ID_', param: taskId },
                { name: 'ACT_NAME_', param: node.name || activityId },
                { name: 'ACT_TYPE_', literal: "'userTask'" },
                { name: 'ASSIGNEE_', param: assignment.assignee },
                { name: 'START_TIME_', param: now },
                { name: 'END_TIME_', literal: 'NULL' },
                { name: 'DURATION_', literal: 'NULL' },
                { name: 'TENANT_ID_', param: proc.tenantId || '', optional: true }
            ])
            await tx.execute(historyActivity.sql, historyActivity.params)
        }
        if (hasTable('act_hi_procinst')) {
            await tx.execute(
                'UPDATE act_hi_procinst SET END_TIME_ = NULL, DURATION_ = NULL, DELETE_REASON_ = NULL, END_ACT_ID_ = NULL WHERE ID_ = ?',
                [instanceId]
            )
        }
    })

    warnings.push('并行分支 / 多实例任务会被合并为单个任务')
    return { taskId, activityId, assignee: assignment.assignee, warnings }
}

// ==================== 流程定义 ====================

async function listDefinitions(keyword = '') {
    const params = []
    let whereSql = ''
    if (keyword) {
        const kw = `%${keyword}%`
        whereSql = `WHERE (p.NAME_ ${likeOp()} ? OR p.KEY_ ${likeOp()} ? OR p.CATEGORY_ ${likeOp()} ?)`
        params.push(kw, kw, kw)
    }

    const baseSelect = `SELECT p.ID_ AS "id", p.KEY_ AS "key", p.NAME_ AS "name", p.VERSION_ AS "version",
                p.CATEGORY_ AS "category", p.DEPLOYMENT_ID_ AS "deploymentId", p.RESOURCE_NAME_ AS "resourceName",
                p.SUSPENSION_STATE_ AS "suspensionState", p.DESCRIPTION_ AS "description"`
    const orderBy = 'ORDER BY p.KEY_ ASC, p.VERSION_ DESC'

    let rows
    if (hasTable('act_re_deployment')) {
        rows = await query(
            `${baseSelect}, d.DEPLOY_TIME_ AS "deployTime"
             FROM act_re_procdef p
             LEFT JOIN act_re_deployment d ON p.DEPLOYMENT_ID_ = d.ID_
             ${whereSql} ${orderBy}`,
            params
        )
    } else {
        rows = await query(`${baseSelect}, NULL AS "deployTime" FROM act_re_procdef p ${whereSql} ${orderBy}`, params)
    }

    const runningCounts = new Map()
    if (hasTable('act_ru_execution')) {
        try {
            const counts = await query(
                `SELECT PROC_DEF_ID_ AS "procDefId", COUNT(*) AS "total"
                 FROM act_ru_execution WHERE PARENT_ID_ IS NULL GROUP BY PROC_DEF_ID_`
            )
            counts.forEach((row) => runningCounts.set(row.procDefId, Number(row.total || 0)))
        } catch (error) {
            console.warn('[DEFINITIONS] 运行实例统计失败:', error.message)
        }
    }

    return rows.map((row) => ({
        ...row,
        runningCount: runningCounts.get(row.id) || 0,
        suspended: Number(row.suspensionState) === 2
    }))
}

async function updateDefinitionXml(definitionId, xml) {
    if (typeof xml !== 'string' || xml.trim() === '') throw new ApiError('XML 内容不能为空')
    if (!/<(?:\w+:)?definitions[\s>]/.test(xml) || !/<(?:\w+:)?process[\s>]/.test(xml)) {
        throw new ApiError('XML 内容不完整：必须包含 definitions 与 process 节点')
    }

    const definition = await getDefinition(definitionId)
    const byteArrayId = await findByteArrayId(definitionId, definition)
    if (!byteArrayId) throw new ApiError('未找到该流程定义的 BPMN 文件', 404)

    await execute('UPDATE act_ge_bytearray SET BYTES_ = ? WHERE ID_ = ?', [Buffer.from(xml, 'utf8'), byteArrayId])
    definitionXmlCache.delete(definitionId)
    cacheDefinitionXml(definitionId, xml)
    return { byteArrayId }
}

async function setDefinitionSuspension(definitionId, suspended) {
    const definition = await getDefinition(definitionId)
    await execute('UPDATE act_re_procdef SET SUSPENSION_STATE_ = ? WHERE ID_ = ?', [suspended ? 2 : 1, definitionId])
    return definition
}

// ==================== 定时作业 ====================

const JOB_SOURCES = [
    { table: 'act_ru_job', source: 'async', label: '异步作业' },
    { table: 'act_ru_timer_job', source: 'timer', label: '定时器' },
    { table: 'act_ru_suspended_job', source: 'suspended', label: '已挂起' },
    { table: 'act_ru_deadletter_job', source: 'deadletter', label: '死信' }
]

function getJobSource(source) {
    const found = JOB_SOURCES.find((item) => item.source === source)
    if (!found) throw new ApiError('未知的作业类型')
    if (!hasTable(found.table)) throw new ApiError('数据库中不存在该作业表')
    return found
}

async function listJobs(options = {}) {
    const limit = Math.min(200, Math.max(1, toInt(options.size, 100)))
    const keyword = (options.keyword || '').trim()
    const onlyFailed = options.state === 'failed'

    const jobs = []
    for (const source of JOB_SOURCES) {
        if (!hasTable(source.table)) continue
        try {
            // 作业表各项差异很大：Activiti 6.0 用 PROC_DEF_ID_，改造库可能沿用 Flowable 的
            // PROCESS_DEFINITION_ID_；act_ru_deadletter_job 又没有 RETRIES_ / LOCK_OWNER_。
            const columns = await getColumns(source.table)
            const col = (candidates, alias) => {
                const name = pickColumn(columns, candidates)
                return name ? `${name} AS "${alias}"` : `NULL AS "${alias}"`
            }

            const params = []
            const conditions = []
            if (keyword) {
                const kw = `%${keyword}%`
                const parts = ['ID_', 'PROCESS_INSTANCE_ID_', 'EXCEPTION_MSG_', 'HANDLER_TYPE_']
                    .filter((name) => pickColumn(columns, [name]))
                    .map((name) => `${name} ${likeOp()} ?`)
                if (parts.length > 0) {
                    conditions.push(`(${parts.join(' OR ')})`)
                    parts.forEach(() => params.push(kw))
                }
            }
            if (onlyFailed && pickColumn(columns, ['RETRIES_'])) conditions.push('RETRIES_ <= 0')
            const whereSql = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
            const orderSql = pickColumn(columns, ['DUEDATE_']) ? 'DUEDATE_ ASC' : 'ID_ ASC'

            const select = [
                col(['ID_'], 'id'),
                col(['TYPE_'], 'type'),
                col(['RETRIES_'], 'retries'),
                col(['EXCEPTION_MSG_'], 'exceptionMessage'),
                col(['DUEDATE_'], 'dueDate'),
                col(['PROCESS_INSTANCE_ID_'], 'processInstanceId'),
                col(['EXECUTION_ID_'], 'executionId'),
                col(['PROC_DEF_ID_', 'PROCESS_DEFINITION_ID_'], 'processDefinitionId'),
                col(['HANDLER_TYPE_'], 'handlerType'),
                col(['LOCK_OWNER_'], 'lockOwner'),
                col(['TENANT_ID_'], 'tenantId')
            ]

            const rows = await query(
                `SELECT ${select.join(', ')}
                 FROM ${source.table} ${whereSql}
                 ORDER BY ${orderSql}
                 LIMIT ${limit}`,
                params
            )
            rows.forEach((row) => jobs.push({ ...row, source: source.source, sourceLabel: source.label }))
        } catch (error) {
            console.warn(`[JOBS] ${source.table}:`, error.message)
        }
    }

    jobs.sort((a, b) => {
        const left = a.dueDate ? new Date(a.dueDate).getTime() : Number.MAX_SAFE_INTEGER
        const right = b.dueDate ? new Date(b.dueDate).getTime() : Number.MAX_SAFE_INTEGER
        return left - right
    })

    const limited = jobs.slice(0, limit)
    await ensureUsersFresh()
    for (const job of limited) {
        job.failed = Number(job.retries) <= 0
    }
    return { items: limited, total: jobs.length }
}

async function executeJob(jobId, source) {
    const jobSource = getJobSource(source)
    if (!['async', 'timer'].includes(jobSource.source)) {
        throw new ApiError('仅异步作业与定时器支持立即执行')
    }
    const result = await execute(
        `UPDATE ${jobSource.table}
         SET DUEDATE_ = ?, LOCK_EXP_TIME_ = NULL, LOCK_OWNER_ = NULL,
             RETRIES_ = CASE WHEN RETRIES_ IS NULL OR RETRIES_ <= 0 THEN 1 ELSE RETRIES_ END
         WHERE ID_ = ?`,
        [new Date(), jobId]
    )
    if (result.affectedRows === 0) throw new ApiError('作业不存在或已被执行', 404)
}

async function setJobRetries(jobId, source, retries) {
    const jobSource = getJobSource(source)
    const value = toInt(retries, 3)
    if (value < 0 || value > 100) throw new ApiError('重试次数需要在 0 - 100 之间')
    if (!(await hasColumn(jobSource.table, 'RETRIES_'))) {
        throw new ApiError(`${jobSource.label}表没有重试次数字段，不支持重置重试`)
    }
    const result = await execute(`UPDATE ${jobSource.table} SET RETRIES_ = ? WHERE ID_ = ?`, [value, jobId])
    if (result.affectedRows === 0) throw new ApiError('作业不存在', 404)
}

async function deleteJob(jobId, source) {
    const jobSource = getJobSource(source)
    let stackId = null
    try {
        const rows = await query(`SELECT EXCEPTION_STACK_ID_ AS "stackId" FROM ${jobSource.table} WHERE ID_ = ?`, [jobId])
        if (rows.length > 0) stackId = rows[0].stackId
    } catch (error) {
        // 部分作业表没有异常堆栈字段
    }
    const result = await execute(`DELETE FROM ${jobSource.table} WHERE ID_ = ?`, [jobId])
    if (result.affectedRows === 0) throw new ApiError('作业不存在', 404)

    if (stackId && hasTable('act_ge_bytearray')) {
        try {
            await execute('DELETE FROM act_ge_bytearray WHERE ID_ = ?', [stackId])
        } catch (error) {
            console.warn('[JOBS] 清理异常堆栈失败:', error.message)
        }
    }
}

// ==================== 概览统计 ====================

async function getOverview() {
    const today = startOfToday()
    const [runningInstances, pendingTasks, unassignedTasks, finishedToday, failedJobs, definitions] = await Promise.all([
        safeCount('act_ru_execution', 'PARENT_ID_ IS NULL'),
        safeCount('act_ru_task'),
        safeCount('act_ru_task', "ASSIGNEE_ IS NULL OR ASSIGNEE_ = ''"),
        safeCount('act_hi_procinst', 'END_TIME_ >= ?', [today]),
        safeCount('act_ru_job', 'RETRIES_ <= 0'),
        safeCount('act_re_procdef')
    ])

    let timerJobs = null
    if (hasTable('act_ru_timer_job')) {
        timerJobs = await safeCount('act_ru_timer_job')
    }
    let deadLetterJobs = null
    if (hasTable('act_ru_deadletter_job')) {
        deadLetterJobs = await safeCount('act_ru_deadletter_job')
    }

    return {
        runningInstances,
        pendingTasks,
        unassignedTasks,
        finishedToday,
        failedJobs,
        definitions,
        timerJobs,
        deadLetterJobs,
        serverTime: new Date().toISOString(),
        connection: {
            dbType: dbState.type,
            host: dbState.config?.host,
            port: dbState.config?.port,
            database: dbState.config?.database,
            schema: dbState.config?.schema || null
        }
    }
}

// ==================== HTTP 路由 ====================

app.disable('x-powered-by')
app.use(express.json({ limit: '4mb' }))
app.use(express.static(getPublicPath()))

// ---- 连接配置 ----

app.get('/api/health', (req, res) => {
    res.json({ ok: true, connected: !!dbState.pool, version: '2.0.0' })
})

app.get('/api/connection-status', wrap(async (req, res) => {
    if (!dbState.pool) return res.json({ connected: false, config: null })
    await ensureUsersFresh()
    const summary = { ...dbState.config, password: undefined }
    res.json({
        connected: true,
        config: summary,
        tables: dbState.tables.size,
        userTable: hasTable('sys_user')
    })
}))

app.post('/api/test-connection', wrap(async (req, res) => {
    const config = normalizeConfig(req.body)
    if (!config.database) throw new ApiError('请填写数据库名称')
    if (!config.username) throw new ApiError('请填写用户名')

    const pool = await createPool(config)
    try {
        if (config.dbType === 'mysql') {
            await pool.query('SELECT 1')
        } else {
            await pool.query('SELECT 1')
        }
        const tables = await loadTableSet(pool, config.dbType)
        if (!tables.has('act_hi_procinst')) {
            throw new ApiError(
                config.schema
                    ? `连接成功，但在 schema "${config.schema}" 中未找到 Activiti 表`
                    : '连接成功，但未找到 Activiti 工作流表，请检查数据库名或 schema'
            )
        }
        res.json({ success: true, message: '连接成功', tables: tables.size })
    } finally {
        await closePool(pool, config)
    }
}))

app.post('/api/test-basic-connection', wrap(async (req, res) => {
    const config = normalizeConfig(req.body)
    if (!config.username) throw new ApiError('请填写用户名')

    let databases = []
    let pool = null
    try {
        if (config.dbType === 'mysql') {
            pool = mysql.createPool({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                waitForConnections: true,
                connectionLimit: 1,
                connectTimeout: 10000
            })
            const [rows] = await pool.query('SHOW DATABASES')
            databases = rows
                .map((row) => Object.values(row)[0])
                .filter((name) => !['information_schema', 'performance_schema', 'mysql', 'sys', 'test'].includes(name))
                .map(String)
        } else {
            pool = new Pool({
                host: config.host,
                port: config.port,
                user: config.username,
                password: config.password,
                database: config.dbType === 'hgdatabase' ? 'highgo' : 'postgres',
                max: 1,
                connectionTimeoutMillis: 10000
            })
            const result = await pool.query(
                'SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname'
            )
            databases = result.rows.map((row) => String(row.datname))
        }
    } catch (error) {
        // 瀚高 / 部分 PG 缺少 postgres 库时，退回尝试已填写的数据库
        if (isPostgresType(config.dbType) && config.database) {
            try {
                if (pool) await pool.end().catch(() => {})
                pool = new Pool({
                    host: config.host,
                    port: config.port,
                    user: config.username,
                    password: config.password,
                    database: config.database,
                    max: 1,
                    connectionTimeoutMillis: 10000
                })
                await pool.query('SELECT 1')
                databases = [config.database]
            } catch (retryError) {
                throw error
            }
        } else {
            throw error
        }
    } finally {
        if (pool) await pool.end().catch(() => {})
    }

    res.json({ success: true, databases })
}))

function isPostgresType(dbType) {
    return dbType === 'postgres' || dbType === 'hgdatabase'
}

app.post('/api/get-schemas', wrap(async (req, res) => {
    const config = normalizeConfig(req.body)
    if (!isPostgresType(config.dbType)) return res.json({ success: true, schemas: [] })
    if (!config.database) throw new ApiError('请先选择数据库')

    const pool = new Pool({
        host: config.host,
        port: config.port,
        user: config.username,
        password: config.password,
        database: config.database,
        max: 1,
        connectionTimeoutMillis: 10000
    })
    try {
        const result = await pool.query(
            `SELECT schema_name FROM information_schema.schemata
             WHERE schema_name NOT IN ('information_schema', 'pg_catalog', 'pg_toast', 'pg_temp_1', 'pg_toast_temp_1')
             ORDER BY schema_name`
        )
        res.json({ success: true, schemas: result.rows.map((row) => String(row.schema_name)) })
    } finally {
        await pool.end().catch(() => {})
    }
}))

app.get('/api/connections', wrap(async (req, res) => {
    const rows = localAll(
        'SELECT id, name, db_type, host, port, database, username, schema FROM connections ORDER BY id DESC'
    )
    res.json(rows)
}))

app.get('/api/connections/:id', wrap(async (req, res) => {
    const rows = localAll('SELECT * FROM connections WHERE id = ?', [toInt(req.params.id, 0)])
    if (rows.length === 0) throw new ApiError('配置不存在', 404)
    res.json(rows[0])
}))

app.post('/api/connections', wrap(async (req, res) => {
    const config = normalizeConfig(req.body)
    const name = requireString(config.name, '连接名称', 100)
    if (!config.database) throw new ApiError('请填写数据库名称')
    if (!config.username) throw new ApiError('请填写用户名')

    const id = req.body.id ? toInt(req.body.id, 0) : 0
    if (id) {
        localDb.run(
            `UPDATE connections SET name = ?, db_type = ?, host = ?, port = ?, database = ?, username = ?, password = ?, schema = ? WHERE id = ?`,
            [name, config.dbType, config.host, config.port, config.database, config.username, config.password, config.schema || null, id]
        )
        saveLocalDb()
        return res.json({ success: true, id })
    }

    localDb.run(
        `INSERT INTO connections (name, db_type, host, port, database, username, password, schema)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [name, config.dbType, config.host, config.port, config.database, config.username, config.password, config.schema || null]
    )
    saveLocalDb()
    const result = localAll('SELECT MAX(id) AS id FROM connections')
    res.json({ success: true, id: Number(result[0]?.id || 0) })
}))

app.delete('/api/connections/:id', wrap(async (req, res) => {
    localDb.run('DELETE FROM connections WHERE id = ?', [toInt(req.params.id, 0)])
    saveLocalDb()
    res.json({ success: true })
}))

app.post('/api/connect', wrap(async (req, res) => {
    const config = normalizeConfig(req.body)
    if (!config.database) throw new ApiError('请填写数据库名称')
    if (!config.username) throw new ApiError('请填写用户名')

    const pool = await createPool(config)
    try {
        if (config.dbType === 'mysql') {
            await pool.query('SELECT 1')
        } else {
            await pool.query('SELECT 1')
        }
    } catch (error) {
        await closePool(pool, config)
        throw new ApiError(`连接失败：${error.message}`, 400)
    }

    const tables = await loadTableSet(pool, config.dbType)
    if (!tables.has('act_hi_procinst')) {
        await closePool(pool, config)
        throw new ApiError('连接成功，但未找到 Activiti 工作流表，请检查数据库名或 schema')
    }

    if (dbState.pool) await closePool(dbState.pool, dbState.config)

    dbState.pool = pool
    dbState.type = config.dbType
    dbState.config = config
    dbState.tables = tables
    dbState.users = null
    dbState.userColumns = null
    dbState.userColumnsLoaded = false
    columnCache.clear()
    definitionXmlCache.clear()

    await loadUsers(true)

    res.json({
        success: true,
        message: '已连接到数据库',
        tables: tables.size,
        userTable: hasTable('sys_user')
    })
}))

app.post('/api/disconnect', wrap(async (req, res) => {
    if (dbState.pool) await closePool(dbState.pool, dbState.config)
    dbState.pool = null
    dbState.type = null
    dbState.config = null
    dbState.tables = new Set()
    dbState.users = null
    dbState.userColumns = null
    dbState.userColumnsLoaded = false
    columnCache.clear()
    definitionXmlCache.clear()
    res.json({ success: true })
}))

app.get('/api/overview', requireConnection, wrap(async (req, res) => {
    res.json(await getOverview())
}))

app.get('/api/users', requireConnection, wrap(async (req, res) => {
    const users = await loadUsers()
    const keyword = String(req.query.keyword || '').trim().toLowerCase()
    const list = users.list.filter((user) => {
        if (!keyword) return true
        return [user.id, user.username, user.realname]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(keyword))
    })
    res.json({ available: users.list.length > 0, items: list })
}))

// ---- 流程实例 ----

app.get('/api/instances', requireConnection, wrap(async (req, res) => {
    res.json(await listInstances(req.query))
}))

app.get('/api/instances/:id', requireConnection, wrap(async (req, res) => {
    res.json(await getInstanceDetail(req.params.id))
}))

app.post('/api/instances/:id/suspend', requireConnection, wrap(async (req, res) => {
    await setInstanceSuspension(req.params.id, true)
    logAudit('挂起流程实例', req.params.id)
    res.json({ success: true })
}))

app.post('/api/instances/:id/activate', requireConnection, wrap(async (req, res) => {
    await setInstanceSuspension(req.params.id, false)
    logAudit('激活流程实例', req.params.id)
    res.json({ success: true })
}))

app.post('/api/instances/:id/terminate', requireConnection, wrap(async (req, res) => {
    const reason = (req.body && req.body.reason) || ''
    const result = await terminateInstance(req.params.id, reason)
    logAudit('终止流程实例', req.params.id, reason)
    res.json({ success: true, ...result })
}))

app.delete('/api/instances/:id', requireConnection, wrap(async (req, res) => {
    await purgeInstance(req.params.id)
    logAudit('删除流程实例', req.params.id, '运行时与历史数据全部删除')
    res.json({ success: true })
}))

app.post('/api/instances/:id/migrate', requireConnection, wrap(async (req, res) => {
    const definitionId = requireString(req.body && req.body.definitionId, '目标流程定义', 64)
    const result = await migrateInstance(req.params.id, definitionId)
    logAudit('变更流程版本', req.params.id, `${result.definition.key} v${result.definition.version}`)
    res.json({ success: true, definition: result.definition })
}))

app.get('/api/instances/:id/variables', requireConnection, wrap(async (req, res) => {
    res.json(await listVariables(req.params.id))
}))

app.post('/api/instances/:id/variables', requireConnection, wrap(async (req, res) => {
    await saveVariable(req.params.id, req.body || {})
    logAudit('修改变量', req.params.id, `${req.body.name} = ${String(req.body.value).slice(0, 100)}`)
    res.json({ success: true })
}))

app.delete('/api/instances/:id/variables/:name', requireConnection, wrap(async (req, res) => {
    await deleteVariable(req.params.id, req.params.name)
    logAudit('删除变量', req.params.id, req.params.name)
    res.json({ success: true })
}))

app.get('/api/instances/:id/history-tasks', requireConnection, wrap(async (req, res) => {
    res.json(await listHistoryTasks(req.params.id))
}))

app.get('/api/instances/:id/activities', requireConnection, wrap(async (req, res) => {
    res.json(await listActivities(req.params.id))
}))

app.post('/api/instances/:id/jump-to-task', requireConnection, wrap(async (req, res) => {
    const taskId = requireString(req.body && req.body.taskId, '目标任务', 64)
    const result = await jumpToHistoryTask(req.params.id, taskId)
    logAudit('退回历史节点', req.params.id, `${taskId} / ${result.activityId}`)
    res.json({ success: true, ...result })
}))

app.post('/api/instances/:id/jump-to-activity', requireConnection, wrap(async (req, res) => {
    const activityId = requireString(req.body && req.body.activityId, '目标节点', 255)
    const result = await jumpToActivity(req.params.id, activityId)
    logAudit('跳转到节点', req.params.id, activityId)
    res.json({ success: true, ...result })
}))

app.put('/api/history-tasks/:taskId', requireConnection, wrap(async (req, res) => {
    const result = await updateHistoryTask(req.params.taskId, req.body || {})
    logAudit('修改历史任务', req.params.taskId)
    res.json({ success: true, ...(result || {}) })
}))

app.delete('/api/history-tasks/:taskId', requireConnection, wrap(async (req, res) => {
    await deleteHistoryTask(req.params.taskId)
    logAudit('删除历史任务', req.params.taskId)
    res.json({ success: true })
}))

// 兼容旧前端调用
app.put('/api/history-tasks/:taskId/assignee', requireConnection, wrap(async (req, res) => {
    const result = await updateHistoryTask(req.params.taskId, req.body || {})
    logAudit('修改历史任务', req.params.taskId)
    res.json({ success: true, ...(result || {}) })
}))

// ---- 任务 ----

app.get('/api/tasks', requireConnection, wrap(async (req, res) => {
    res.json(await listTasks(req.query))
}))

app.post('/api/tasks/:taskId/set-assignee', requireConnection, wrap(async (req, res) => {
    const assignee = req.body && req.body.assignee ? String(req.body.assignee) : ''
    await setTaskAssignee(req.params.taskId, assignee)
    logAudit('设置任务审批人', req.params.taskId, assignee || '清空审批人')
    res.json({ success: true })
}))

app.post('/api/tasks/:taskId/suspend', requireConnection, wrap(async (req, res) => {
    await setTaskSuspension(req.params.taskId, true)
    logAudit('挂起任务', req.params.taskId)
    res.json({ success: true })
}))

app.post('/api/tasks/:taskId/activate', requireConnection, wrap(async (req, res) => {
    await setTaskSuspension(req.params.taskId, false)
    logAudit('激活任务', req.params.taskId)
    res.json({ success: true })
}))

app.get('/api/tasks/:taskId/identitylinks', requireConnection, wrap(async (req, res) => {
    res.json(await listTaskIdentityLinks(req.params.taskId))
}))

app.post('/api/tasks/:taskId/identitylinks', requireConnection, wrap(async (req, res) => {
    const userId = requireString(req.body && req.body.userId, '用户', 255)
    const type = (req.body && req.body.type) || 'candidate'
    await addTaskIdentityLink(req.params.taskId, userId, type)
    logAudit('添加任务候选人', req.params.taskId, `${userId} (${type})`)
    res.json({ success: true })
}))

// 兼容旧前端
app.post('/api/tasks/:taskId/add-identitylink', requireConnection, wrap(async (req, res) => {
    const userId = requireString(req.body && req.body.userId, '用户', 255)
    await addTaskIdentityLink(req.params.taskId, userId, (req.body && req.body.type) || 'candidate')
    logAudit('添加任务候选人', req.params.taskId, userId)
    res.json({ success: true })
}))

app.delete('/api/tasks/:taskId/identitylinks', requireConnection, wrap(async (req, res) => {
    const { userId, groupId, type } = req.query
    await removeTaskIdentityLink(req.params.taskId, userId, groupId, type)
    logAudit('删除任务候选人', req.params.taskId, String(userId || groupId || ''))
    res.json({ success: true })
}))

app.delete('/api/tasks/:taskId/identitylink', requireConnection, wrap(async (req, res) => {
    const { userId, groupId, type } = req.query
    await removeTaskIdentityLink(req.params.taskId, userId, groupId, type)
    logAudit('删除任务候选人', req.params.taskId, String(userId || groupId || ''))
    res.json({ success: true })
}))

// ---- 流程定义 ----

app.get('/api/definitions', requireConnection, wrap(async (req, res) => {
    res.json(await listDefinitions(String(req.query.keyword || '').trim()))
}))

app.get('/api/definitions/:id/xml', requireConnection, wrap(async (req, res) => {
    const definition = await getDefinition(req.params.id)
    const xml = await readDefinitionXml(req.params.id, definition)
    res.json({ xml, definition })
}))

app.put('/api/definitions/:id/xml', requireConnection, wrap(async (req, res) => {
    const xml = req.body && req.body.xml
    const result = await updateDefinitionXml(req.params.id, xml)
    logAudit('修改流程图', req.params.id, `${xml.length} 字符`)
    res.json({ success: true, ...result })
}))

app.get('/api/definitions/:id/nodes', requireConnection, wrap(async (req, res) => {
    const definition = await getDefinition(req.params.id)
    const xml = await readDefinitionXml(req.params.id, definition)
    const nodes = parseBpmnNodes(xml)
    res.json({ definition, nodes })
}))

app.get('/api/definitions/:id/affected-instances', requireConnection, wrap(async (req, res) => {
    if (!hasTable('act_hi_procinst')) return res.json({ total: 0, earliestStart: null, latestStart: null })
    const rows = await query(
        `SELECT COUNT(*) AS "total", MIN(START_TIME_) AS "earliestStart", MAX(START_TIME_) AS "latestStart"
         FROM act_hi_procinst WHERE PROC_DEF_ID_ = ?`,
        [req.params.id]
    )
    const row = rows[0] || {}
    res.json({
        total: Number(row.total || 0),
        earliestStart: row.earliestStart || null,
        latestStart: row.latestStart || null
    })
}))

app.post('/api/definitions/:id/suspend', requireConnection, wrap(async (req, res) => {
    await setDefinitionSuspension(req.params.id, true)
    logAudit('挂起流程定义', req.params.id)
    res.json({ success: true })
}))

app.post('/api/definitions/:id/activate', requireConnection, wrap(async (req, res) => {
    await setDefinitionSuspension(req.params.id, false)
    logAudit('激活流程定义', req.params.id)
    res.json({ success: true })
}))

// ---- 定时作业 ----

app.get('/api/jobs', requireConnection, wrap(async (req, res) => {
    res.json(await listJobs(req.query))
}))

app.post('/api/jobs/:id/execute', requireConnection, wrap(async (req, res) => {
    const source = (req.body && req.body.source) || 'async'
    await executeJob(req.params.id, source)
    logAudit('立即执行作业', req.params.id, source)
    res.json({ success: true })
}))

app.post('/api/jobs/:id/retries', requireConnection, wrap(async (req, res) => {
    const source = (req.body && req.body.source) || 'async'
    const retries = (req.body && req.body.retries) === undefined ? 3 : req.body.retries
    await setJobRetries(req.params.id, source, retries)
    logAudit('重置作业重试次数', req.params.id, `${source} -> ${retries}`)
    res.json({ success: true })
}))

app.delete('/api/jobs/:id', requireConnection, wrap(async (req, res) => {
    const source = req.query.source || 'async'
    await deleteJob(req.params.id, source)
    logAudit('删除作业', req.params.id, source)
    res.json({ success: true })
}))

// ---- 操作日志 ----

app.get('/api/audit-logs', requireConnection, wrap(async (req, res) => {
    const limit = Math.min(500, Math.max(1, toInt(req.query.limit, 100)))
    res.json(localAll('SELECT id, created_at, action, target, detail FROM audit_logs ORDER BY id DESC LIMIT ?', [limit]))
}))

app.delete('/api/audit-logs', wrap(async (req, res) => {
    localDb.run('DELETE FROM audit_logs')
    saveLocalDb()
    res.json({ success: true })
}))

app.use('/api', (req, res) => {
    res.status(404).json({ error: `接口不存在: ${req.method} ${req.originalUrl}` })
})

app.use((error, req, res, next) => {
    if (res.headersSent) return next(error)
    if (error && error.type === 'entity.parse.failed') {
        return res.status(400).json({ error: '请求体不是合法的 JSON' })
    }
    console.error('[UNHANDLED]', error)
    res.status(500).json({ error: error.message || '服务器内部错误' })
})

// ==================== 启动 ====================

function openBrowser(url) {
    if (process.env.NO_OPEN === '1' || process.argv.includes('--no-open')) return
    try {
        if (process.platform === 'win32') exec(`start "" "${url}"`)
        else if (process.platform === 'darwin') exec(`open "${url}"`)
        else exec(`xdg-open "${url}"`)
    } catch (error) {
        console.warn('[WARN] 自动打开浏览器失败，请手动访问:', url)
    }
}

async function start() {
    await initLocalDb()

    const server = app.listen(PORT, '127.0.0.1', () => {
        const url = `http://localhost:${PORT}`
        console.log('============================================')
        console.log('  Activiti 工作流运维工具 v2.0.0')
        console.log(`  访问地址: ${url}`)
        console.log(`  本地配置: ${CONFIG_DB_PATH}`)
        console.log('  按 Ctrl+C 停止服务')
        console.log('============================================')
        openBrowser(url)
    })

    server.on('error', (error) => {
        if (error.code === 'EADDRINUSE') {
            console.error(`[ERROR] 端口 ${PORT} 已被占用，请关闭占用程序，或使用 PORT=xxxx 启动`)
        } else {
            console.error('[ERROR] 服务启动失败:', error.message)
        }
        process.exit(1)
    })
}

async function shutdown() {
    console.log('\n正在关闭服务...')
    try {
        if (dbState.pool) await closePool(dbState.pool, dbState.config)
    } catch (error) {
        console.warn('[WARN]', error.message)
    }
    try {
        saveLocalDb()
        if (localDb) localDb.close()
    } catch (error) {
        console.warn('[WARN]', error.message)
    }
    process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

if (require.main === module) {
    start().catch((error) => {
        console.error('[FATAL] 启动失败:', error)
        process.exit(1)
    })
}

module.exports = {
    app,
    start,
    _internal: {
        toPgSql,
        toCamelCase,
        convertRow,
        buildInsert,
        columnCache,
        parseBpmnNodes,
        parseAttributes,
        normalizeConfig,
        decodeVariable,
        buildVariableColumns
    }
}
