package config

import "time"

type Config struct {
	JWTSecret     string
	JWTExpiration time.Duration
}
