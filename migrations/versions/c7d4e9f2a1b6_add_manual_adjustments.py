"""Add client-day manual adjustments

Revision ID: c7d4e9f2a1b6
Revises: a8d3e6f1b4c2
Create Date: 2026-08-13
"""
from alembic import op
import sqlalchemy as sa


revision = 'c7d4e9f2a1b6'
down_revision = 'a8d3e6f1b4c2'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'manual_adjustment',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('date', sa.Date(), nullable=False),
        sa.Column('client_id', sa.Integer(), nullable=False),
        sa.Column('adjustment_minutes', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('updated_at', sa.DateTime(), nullable=False),
        sa.ForeignKeyConstraint(['client_id'], ['client.id'], ondelete='CASCADE'),
        sa.CheckConstraint(
            'adjustment_minutes != 0', name='ck_manual_adjustment_nonzero'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'date', 'client_id', name='uq_manual_adjustment_date_client'
        ),
    )
    op.create_index(
        'ix_manual_adjustment_date_client',
        'manual_adjustment',
        ['date', 'client_id'],
        unique=False,
    )


def downgrade():
    op.drop_index(
        'ix_manual_adjustment_date_client', table_name='manual_adjustment'
    )
    op.drop_table('manual_adjustment')
