"""Add work table and backfill it from task__item.description

Revision ID: e5a9c7d1f2b3
Revises: c4f8a1b2d3e4
Create Date: 2026-08-06

Works supersede per-task descriptions: a work belongs to a (client, date)
rather than to a single time block. The old `task__item.description` column is
deliberately *left in place* but no longer read or written, so this migration is
additive and reversible without data loss.

Backfill rule: one work per non-empty description, verbatim (descriptions often
contain commas as prose, so splitting on them would mangle text), deduplicated
per client+date case-insensitively, skipping tasks whose client has since been
deleted (client_id IS NULL) because a work cannot exist without a client.
"""
from alembic import op
import sqlalchemy as sa


revision = 'e5a9c7d1f2b3'
down_revision = 'c4f8a1b2d3e4'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'work',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('client_id', sa.Integer(), nullable=False),
        sa.Column('text', sa.Text(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['client_id'], ['client.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('date', 'client_id', 'text', name='uq_work_date_client_text'),
    )
    op.create_index('ix_work_date_client', 'work', ['date', 'client_id'])

    _backfill(op.get_bind())


def downgrade():
    op.drop_index('ix_work_date_client', table_name='work')
    op.drop_table('work')


def _backfill(conn):
    """Copy descriptions into works. Shared with the startup path in main.py.

    Ordered by (date, client, start_time) so `created_at` — and therefore the
    order works are listed and copied in — follows the order the day actually
    happened in.
    """
    rows = conn.execute(
        sa.text(
            """
            SELECT date, client_id, description, start_time
            FROM task__item
            WHERE client_id IS NOT NULL
              AND description IS NOT NULL
              AND TRIM(description) != ''
            ORDER BY date, client_id, start_time
            """
        )
    ).fetchall()

    seen = set()
    payload = []
    for row in rows:
        work_text = (row[2] or '').strip()
        if not work_text:
            continue
        key = (str(row[0]), row[1], work_text.casefold())
        if key in seen:
            continue
        seen.add(key)
        payload.append(
            {
                'date': row[0],
                'client_id': row[1],
                'text': work_text,
                # A synthetic created_at: midnight on the work's own day keeps
                # rows sorting into their day, and inserting in query order
                # makes the id sequence the real tiebreaker.
                'created_at': f'{row[0]} 00:00:00.000000',
            }
        )

    if not payload:
        return

    conn.execute(
        sa.text(
            'INSERT INTO work (date, client_id, text, created_at) '
            'VALUES (:date, :client_id, :text, :created_at)'
        ),
        payload,
    )
