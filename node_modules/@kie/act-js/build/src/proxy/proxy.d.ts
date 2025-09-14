import { ResponseMocker } from "@kie/mock-github";
export declare class ForwardProxy {
    private apis;
    private app;
    private server;
    private logger;
    private currentConnections;
    private currentSocketId;
    private secondaryProxy?;
    private shouldHandleConnect;
    constructor(apis: ResponseMocker<unknown, number>[], verbose?: boolean, shouldHandleConnect?: boolean);
    /**
     * Start the server and return the ip address and port in the form of a string - ip:port
     * If it is already running then throw an error
     * @returns
     */
    start(): Promise<string>;
    /**
     * Gracefully stop the server.
     * If it wasn't running then throw an error
     * @returns
     */
    stop(): Promise<void>;
    /**
     * Return the ip address. Traverses the available network interfaces and returns the first
     * public ipv4 address
     * @returns
     */
    private getIp;
    private initServer;
    /**
     * forward any http(s) connections intiated via CONNECT as is
     */
    private handleCONNECT;
    private handleAPIInterception;
}
