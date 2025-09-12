# chat-server

node-version: 22.19.0

## Run with Docker Compose

Prerequisites: Docker and Docker Compose installed.

### Configuration

The server port is set in the `.env` file:

```
PORT=8080
```

To change the port, edit the `.env` file and restart Docker Compose.

Start the server:

```
docker compose up --build
```

The server will listen on http://localhost:8080.

To run in the background:

```
docker compose up -d --build
```

To stop and remove containers:

```
docker compose down
```
