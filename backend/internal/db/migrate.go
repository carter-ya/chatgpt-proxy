package db

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/exc-works/migrate"
)

// RunMigrations reads SQL migration files from the migrations directory and
// executes them against the given PostgreSQL database.
func RunMigrations(dbURL string) error {
	ctx := context.Background()

	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		return fmt.Errorf("open migration db: %w", err)
	}
	defer db.Close()

	absDir, err := filepath.Abs("migrations")
	if err != nil {
		return fmt.Errorf("resolve migrations dir: %w", err)
	}

	svc, err := migrate.NewService(ctx, migrate.Config{
		Dialect:         migrate.NewPostgresDialect(),
		DB:              db,
		MigrationSource: migrate.DirectorySource{Directory: absDir},
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
