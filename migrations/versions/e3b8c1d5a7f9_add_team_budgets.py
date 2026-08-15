"""Add isolated team budgets and imported historical entries

Revision ID: e3b8c1d5a7f9
Revises: c7d4e9f2a1b6
Create Date: 2026-08-15
"""
from alembic import op
import sqlalchemy as sa


revision = 'e3b8c1d5a7f9'
down_revision = 'c7d4e9f2a1b6'
branch_labels = None
depends_on = None


def upgrade():
    op.create_table(
        'team_budget',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('name', sa.String(length=120), nullable=False),
        sa.Column('client_id', sa.Integer(), nullable=False),
        sa.Column('start_date', sa.Date(), nullable=False),
        sa.Column('end_date', sa.Date(), nullable=False),
        sa.Column('notes', sa.Text(), nullable=True),
        sa.Column('created_at', sa.DateTime(), nullable=False),
        sa.Column('imported_at', sa.DateTime(), nullable=True),
        sa.Column('import_filename', sa.String(length=255), nullable=True),
        sa.Column('import_sha256', sa.String(length=64), nullable=True),
        sa.Column('import_row_count', sa.Integer(), nullable=False),
        sa.Column('import_skipped_count', sa.Integer(), nullable=False),
        sa.CheckConstraint(
            'end_date >= start_date', name='ck_team_budget_dates_ordered'
        ),
        sa.ForeignKeyConstraint(['client_id'], ['client.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_team_budget_client_dates',
        'team_budget',
        ['client_id', 'start_date', 'end_date'],
        unique=False,
    )

    op.create_table(
        'team_budget_member',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('team_budget_id', sa.Integer(), nullable=False),
        sa.Column('source_user_id', sa.String(length=200), nullable=False),
        sa.Column('display_name', sa.String(length=120), nullable=True),
        sa.Column('budgeted_hours', sa.Float(), nullable=False),
        sa.CheckConstraint(
            'budgeted_hours > 0', name='ck_team_budget_member_hours_positive'
        ),
        sa.ForeignKeyConstraint(
            ['team_budget_id'], ['team_budget.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'team_budget_id', 'source_user_id',
            name='uq_team_budget_member_source_id',
        ),
    )
    op.create_index(
        'ix_team_budget_member_budget',
        'team_budget_member',
        ['team_budget_id'],
        unique=False,
    )

    op.create_table(
        'team_budget_member_alias',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('team_budget_id', sa.Integer(), nullable=False),
        sa.Column('member_id', sa.Integer(), nullable=False),
        sa.Column('source_user_id', sa.String(length=200), nullable=False),
        sa.ForeignKeyConstraint(
            ['member_id'], ['team_budget_member.id'], ondelete='CASCADE'
        ),
        sa.ForeignKeyConstraint(
            ['team_budget_id'], ['team_budget.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint(
            'team_budget_id', 'source_user_id',
            name='uq_team_budget_alias_source_id',
        ),
    )
    op.create_index(
        'ix_team_budget_alias_member',
        'team_budget_member_alias',
        ['member_id'],
        unique=False,
    )

    op.create_table(
        'team_budget_entry',
        sa.Column('id', sa.Integer(), nullable=False),
        sa.Column('team_budget_id', sa.Integer(), nullable=False),
        sa.Column('member_id', sa.Integer(), nullable=False),
        sa.Column('work_date', sa.Date(), nullable=False),
        sa.Column('time_seconds', sa.Integer(), nullable=False),
        sa.Column('source_user_id', sa.String(length=200), nullable=False),
        sa.Column('source_row', sa.Integer(), nullable=False),
        sa.CheckConstraint(
            'time_seconds > 0', name='ck_team_budget_entry_seconds_positive'
        ),
        sa.ForeignKeyConstraint(
            ['member_id'], ['team_budget_member.id'], ondelete='RESTRICT'
        ),
        sa.ForeignKeyConstraint(
            ['team_budget_id'], ['team_budget.id'], ondelete='CASCADE'
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index(
        'ix_team_budget_entry_budget_date',
        'team_budget_entry',
        ['team_budget_id', 'work_date'],
        unique=False,
    )
    op.create_index(
        'ix_team_budget_entry_member_date',
        'team_budget_entry',
        ['member_id', 'work_date'],
        unique=False,
    )


def downgrade():
    op.drop_index('ix_team_budget_entry_member_date', table_name='team_budget_entry')
    op.drop_index('ix_team_budget_entry_budget_date', table_name='team_budget_entry')
    op.drop_table('team_budget_entry')
    op.drop_index('ix_team_budget_alias_member', table_name='team_budget_member_alias')
    op.drop_table('team_budget_member_alias')
    op.drop_index('ix_team_budget_member_budget', table_name='team_budget_member')
    op.drop_table('team_budget_member')
    op.drop_index('ix_team_budget_client_dates', table_name='team_budget')
    op.drop_table('team_budget')
