"""Add budget_hold table

Revision ID: b7e2d4c8a1f5
Revises: a4c81f0d92be
Create Date: 2026-08-07

A hold is a stretch of a budget's range during which the project was paused.
Those days sit inside the range but were never going to be worked, and counting
them as working time is what makes the statistics wrong — the projection sags,
the pace reads low, and the burn chart's ideal line climbs against an actual
that cannot move.

Modelled as intervals rather than a boolean on `budget`, because a flag can
only describe the present. It cannot say *which* days were dead, so it cannot
correct any of the arithmetic, and it has no answer for a project paused twice
or for a hold entered after the fact.

`end_date` is nullable: NULL means the hold is still running. See
``budgets.hold_days()`` for why an open hold counts only up to today.

Purely additive. A database with no rows in this table behaves exactly as it
did before — `hold_days()` returns an empty set and `day_capacity()` falls
straight through to the weekday rule.

`ondelete='CASCADE'` is documentation, as everywhere else in this app: SQLite
runs with `foreign_keys` OFF, so the SQLAlchemy relationship carries
`cascade='all, delete-orphan'` and `delete_client()` in main.py clears holds by
hand.
"""
from alembic import op
import sqlalchemy as sa


revision = 'b7e2d4c8a1f5'
down_revision = 'a4c81f0d92be'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'budget_hold',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('budget_id', sa.Integer(), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=True),
        sa.Column('reason', sa.String(length=200), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['budget_id'], ['budget.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.CheckConstraint(
            'end_date IS NULL OR end_date >= start_date',
            name='ck_budget_hold_dates_ordered',
        ),
    )
    op.create_index(
        'ix_budget_hold_budget_dates', 'budget_hold', ['budget_id', 'start_date']
    )


def downgrade():
    op.drop_index('ix_budget_hold_budget_dates', table_name='budget_hold')
    op.drop_table('budget_hold')
