package db

import (
	"context"
	"database/sql"
	"fmt"

	"chatgpt-proxy/backend/migrations"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/exc-works/migrate"
)

// RunMigrations reads SQL migration files from the embedded migrations
// filesystem and executes them against the given PostgreSQL database.
func RunMigrations(dbURL string) error {
	ctx := context.Background()

	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		return fmt.Errorf("open migration db: %w", err)
	}
	defer db.Close()

	svc, err := migrate.NewService(ctx, migrate.Config{
		Dialect:         migrate.NewPostgresDialect(),
		DB:              db,
		MigrationSource: migrate.FSSource{FS: migrations.FS},
		SchemaName:      "migration_schema",
		Logger:          migrate.NoopLogger{},
	})
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}

	if err := svc.Create(); err != nil {
		return fmt.Errorf("create schema history: %w", err)
	}

	if err := svc.Up(); err != nil {
		return fmt.Errorf("run migrations: %w", err)
	}

	return nil
}
