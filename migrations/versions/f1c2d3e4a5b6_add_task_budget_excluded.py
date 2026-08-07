"""add task budget excluded

Revision ID: f1c2d3e4a5b6
Revises: d9f3a6b8c2e1
"""
from alembic import op
import sqlalchemy as sa

revision = 'f1c2d3e4a5b6'
down_revision = 'd9f3a6b8c2e1'
branch_labels = None
depends_on = None


def upgrade():
    with op.batch_alter_table('task__item') as batch_op:
        batch_op.add_column(sa.Column(
            'budget_excluded', sa.Boolean(), nullable=False,
            server_default=sa.text('0'),
        ))


def downgrade():
    with op.batch_alter_table('task__item') as batch_op:
        batch_op.drop_column('budget_excluded')
