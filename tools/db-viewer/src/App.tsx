import { useEffect, useState } from 'react'
import './App.css'

type TableRow = { name: string }
type Column = {
  column_name: string
  column_type: string
  is_nullable: string
  column_default: string | null
  column_key: string
  extra: string
}
type RowsResponse = {
  total: number
  page: number
  limit: number
  rows: Record<string, unknown>[]
}

const LIMIT = 50

export default function App() {
  const [tables, setTables] = useState<TableRow[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [schema, setSchema] = useState<Column[]>([])
  const [rowsData, setRowsData] = useState<RowsResponse | null>(null)
  const [page, setPage] = useState(1)
  const [tab, setTab] = useState<'rows' | 'schema'>('rows')

  useEffect(() => {
    fetch('/dev/tables').then(r => r.json()).then(setTables)
  }, [])

  useEffect(() => {
    if (!selected) return
    setPage(1)
    fetch(`/dev/tables/${selected}/schema`).then(r => r.json()).then(setSchema)
    fetch(`/dev/tables/${selected}/rows?page=1&limit=${LIMIT}`).then(r => r.json()).then(setRowsData)
  }, [selected])

  useEffect(() => {
    if (!selected) return
    fetch(`/dev/tables/${selected}/rows?page=${page}&limit=${LIMIT}`)
      .then(r => r.json()).then(setRowsData)
  }, [page]) // eslint-disable-line react-hooks/exhaustive-deps

  const totalPages = rowsData ? Math.ceil(rowsData.total / LIMIT) : 1
  const columns = rowsData?.rows[0] ? Object.keys(rowsData.rows[0]) : []

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="sidebar-title">Tables</div>
        {tables.map(t => (
          <button
            key={t.name}
            className={`table-btn${selected === t.name ? ' active' : ''}`}
            onClick={() => { setSelected(t.name); setTab('rows') }}
          >
            {t.name}
          </button>
        ))}
      </aside>

      <main className="main">
        {!selected && <div className="empty-state">← テーブルを選択</div>}

        {selected && (
          <>
            <div className="main-header">
              <h2>{selected}</h2>
              <div className="tabs">
                <button className={tab === 'rows' ? 'active' : ''} onClick={() => setTab('rows')}>
                  Rows{rowsData ? ` (${rowsData.total})` : ''}
                </button>
                <button className={tab === 'schema' ? 'active' : ''} onClick={() => setTab('schema')}>
                  Schema
                </button>
              </div>
            </div>

            {tab === 'schema' && (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Column</th><th>Type</th><th>Nullable</th><th>Key</th><th>Default</th><th>Extra</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schema.map(c => (
                      <tr key={c.column_name}>
                        <td><strong>{c.column_name}</strong></td>
                        <td><code>{c.column_type}</code></td>
                        <td>{c.is_nullable}</td>
                        <td>{c.column_key}</td>
                        <td>{c.column_default ?? <span className="null-val">NULL</span>}</td>
                        <td>{c.extra}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {tab === 'rows' && rowsData && (
              <>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>{columns.map(k => <th key={k}>{k}</th>)}</tr>
                    </thead>
                    <tbody>
                      {rowsData.rows.length === 0
                        ? <tr><td colSpan={99} className="empty-state">レコードなし</td></tr>
                        : rowsData.rows.map((row, i) => (
                          <tr key={i}>
                            {Object.values(row).map((v, j) => (
                              <td key={j}>{v === null ? <span className="null-val">NULL</span> : String(v)}</td>
                            ))}
                          </tr>
                        ))
                      }
                    </tbody>
                  </table>
                </div>

                {totalPages > 1 && (
                  <div className="pagination">
                    <button onClick={() => setPage(p => p - 1)} disabled={page <= 1}>←</button>
                    <span>{page} / {totalPages}</span>
                    <button onClick={() => setPage(p => p + 1)} disabled={page >= totalPages}>→</button>
                  </div>
                )}
              </>
            )}
          </>
        )}
      </main>
    </div>
  )
}
