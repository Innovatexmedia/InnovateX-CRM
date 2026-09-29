'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'

type ApprovalStatus = 'pending' | 'approved' | 'suspended'

interface AdminAccount {
  id: string
  name: string
  owner_email: string | null
  owner_name: string | null
  approval_status: ApprovalStatus
  created_at: string
  approved_at: string | null
  suspended_at: string | null
  suspended_reason: string | null
}

interface Stats {
  total_users: number
  total_accounts: number
  pending: number
  approved: number
  suspended: number
}

const STATUS_VARIANT: Record<ApprovalStatus, 'default' | 'secondary' | 'destructive'> = {
  approved: 'default',
  pending: 'secondary',
  suspended: 'destructive',
}

export function AdminAccountsClient() {
  const [accounts, setAccounts] = useState<AdminAccount[]>([])
  const [stats, setStats] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  // Per-row in-flight id so only the button that was clicked shows
  // a busy state — an admin working through a list of pending
  // signups shouldn't have every row lock up while one saves.
  const [pendingActionId, setPendingActionId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/accounts')
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.error || 'Failed to load accounts')
      setAccounts(payload.accounts)
      setStats(payload.stats)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load accounts')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const act = async (id: string, action: 'approve' | 'suspend' | 'reinstate') => {
    setPendingActionId(id)
    try {
      const res = await fetch(`/api/admin/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action }),
      })
      const payload = await res.json()
      if (!res.ok) throw new Error(payload.error || 'Update failed')
      toast.success(
        action === 'suspend' ? 'Account suspended' : 'Account approved',
      )
      await load()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Update failed')
    } finally {
      setPendingActionId(null)
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Platform Admin</h1>
        <p className="text-muted-foreground text-sm">
          Every account on this deployment. Approve a new signup before it can
          log in, or suspend one to cut off access without deleting its data.
        </p>
      </div>

      {stats && (
        <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <StatTile label="Total users" value={stats.total_users} />
          <StatTile label="Total accounts" value={stats.total_accounts} />
          <StatTile label="Pending" value={stats.pending} />
          <StatTile label="Approved" value={stats.approved} />
          <StatTile label="Suspended" value={stats.suspended} />
        </div>
      )}

      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Owner</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Signed up</TableHead>
              <TableHead className="text-right">Action</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  Loading…
                </TableCell>
              </TableRow>
            )}
            {!loading && accounts.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-muted-foreground text-center">
                  No accounts yet.
                </TableCell>
              </TableRow>
            )}
            {accounts.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="font-medium">{a.name}</TableCell>
                <TableCell>
                  <div>{a.owner_name || '—'}</div>
                  <div className="text-muted-foreground text-xs">{a.owner_email}</div>
                </TableCell>
                <TableCell>
                  <Badge variant={STATUS_VARIANT[a.approval_status]}>
                    {a.approval_status}
                  </Badge>
                  {a.approval_status === 'suspended' && a.suspended_reason && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      {a.suspended_reason}
                    </div>
                  )}
                </TableCell>
                <TableCell>{new Date(a.created_at).toLocaleDateString()}</TableCell>
                <TableCell className="text-right">
                  {a.approval_status === 'pending' && (
                    <Button
                      size="sm"
                      disabled={pendingActionId === a.id}
                      onClick={() => act(a.id, 'approve')}
                    >
                      Approve
                    </Button>
                  )}
                  {a.approval_status === 'approved' && (
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={pendingActionId === a.id}
                      onClick={() => act(a.id, 'suspend')}
                    >
                      Suspend
                    </Button>
                  )}
                  {a.approval_status === 'suspended' && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={pendingActionId === a.id}
                      onClick={() => act(a.id, 'reinstate')}
                    >
                      Reinstate
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-4">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  )
}