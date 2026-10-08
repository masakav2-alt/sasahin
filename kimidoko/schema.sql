-- 1. 部署・グループ
CREATE TABLE IF NOT EXISTS departments (
    id SERIAL PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    display_order INT DEFAULT 0
);

-- 2. ステータスマスタ (最大30個、色やアイコン画像)
CREATE TABLE IF NOT EXISTS statuses (
    id SERIAL PRIMARY KEY,
    name VARCHAR(50) NOT NULL,
    icon_url VARCHAR(255),
    color_code VARCHAR(7),
    display_order INT DEFAULT 0
);

-- 3. ユーザー
CREATE TABLE IF NOT EXISTS users (
    id SERIAL PRIMARY KEY,
    department_id INT REFERENCES departments(id),
    name VARCHAR(100) NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    current_status_id INT REFERENCES statuses(id),
    status_updated_at TIMESTAMP WITH TIME ZONE,
    status_updated_by INT REFERENCES users(id),
    display_order INT DEFAULT 0
);

-- 4. 行動予定
CREATE TABLE IF NOT EXISTS user_schedules (
    id SERIAL PRIMARY KEY,
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    status_id INT REFERENCES statuses(id),
    start_time TIMESTAMP WITH TIME ZONE NOT NULL,
    end_time TIMESTAMP WITH TIME ZONE,
    note TEXT,
    source VARCHAR(20) DEFAULT 'manual',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 5. お気に入り登録
CREATE TABLE IF NOT EXISTS user_favorites (
    user_id INT REFERENCES users(id) ON DELETE CASCADE,
    favorite_user_id INT REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (user_id, favorite_user_id)
);

CREATE INDEX IF NOT EXISTS idx_schedules_user_start ON user_schedules(user_id, start_time);
