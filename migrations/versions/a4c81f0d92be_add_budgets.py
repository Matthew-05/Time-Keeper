"""Add budget table and task__item.budget_id

Revision ID: a4c81f0d92be
Revises: e5a9c7d1f2b3
Create Date: 2026-08-07

A budget is a pot of hours for one client over one inclusive date range.
Consumption is never stored — it's derived from the tasks on every read (see
``budgets.py``), because a cached total would be stale the moment an entry was
edited in the Task Browser.

`task__item.budget_id` is the manual override on the bucket-fill allocator.
It's nullable and defaults to NULL for every existing row, so this migration is
purely additive: allocation behaviour before and after is identical until
somebody actually pins something.

`ondelete='SET NULL'` on that column is the important half of the design —
deleting a budget must un-pin the time, never delete it. SQLite runs with
`foreign_keys` OFF in this app, so `delete_budget()` in main.py clears the
column by hand, exactly as `delete_client()` does for tasks.
"""
from alembic import op
import sqlalchemy as sa


revision = 'a4c81f0d92be'
down_revision = 'e5a9c7d1f2b3'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'budget',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('client_id', sa.Integer(), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('budgeted_hours', sa.Float(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['client_id'], ['client.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint('end_date >= start_date', name='ck_budget_dates_ordered'),
        sa.CheckConstraint('budgeted_hours > 0', name='ck_budget_hours_positive'),
    )
    op.create_index(
        'ix_budget_client_dates', 'budget', ['client_id', 'start_date', 'end_date']
    )

    # batch_alter_table because SQLite can't add a column with a foreign key
    # in place — Alembic rebuilds the table instead.
    with op.batch_alter_table('task__item') as batch:
        batch.add_column(sa.Column('budget_id', sa.Integer(), nullable=True))
        batch.create_index('ix_task__item_budget_id', ['budget_id'])
        batch.create_foreign_key(
            'fk_task__item_budget_id', 'budget', ['budget_id'], ['id'],
            ondelete='SET NULL',
        )


def downgrade():
    with op.batch_alter_table('task__item') as batch:
        batch.drop_constraint('fk_task__item_budget_id', type_='foreignkey')
        batch.drop_index('ix_task__item_budget_id')
        batch.drop_column('budget_id')

    op.drop_index('ix_budget_client_dates', table_name='budget')
    op.drop_table('budget')
