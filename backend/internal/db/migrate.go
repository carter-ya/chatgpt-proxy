package db

import (
	"database/sql"
	"fmt"
	"path/filepath"

	_ "github.com/jackc/pgx/v5/stdlib"

	"github.com/golang-migrate/migrate/v4"
	"github.com/golang-migrate/migrate/v4/database/postgres"
	_ "github.com/golang-migrate/migrate/v4/source/file"
)

// RunMigrations reads SQL migration files from the migrations directory and
// executes them against the given PostgreSQL database.
func RunMigrations(dbURL string) error {
	db, err := sql.Open("pgx", dbURL)
	if err != nil {
		return fmt.Errorf("open migration db: %w", err)
	}
	defer db.Close()

	driver, err := postgres.WithInstance(db, &postgres.Config{})
	if err != nil {
		return fmt.Errorf("create migration driver: %w", err)
	}

	absDir, err := filepath.Abs("migrations")
	if err != nil {
		return fmt.Errorf("resolve migrations dir: %w", err)
	}

	m, err := migrate.NewWithDatabaseInstance(
		"file://"+absDir,
		"postgres",
		driver,
	)
	if err != nil {
		return fmt.Errorf("create migrator: %w", err)
	}

	if err := m.Up(); err != nil && err != migrate.ErrNoChange {
		return fmt.Errorf("run migrations: %w", err)
	}

	return nil
}
