import { Transaction, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { Connection, PublicKey, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { PumpFunSDK } from "pumpdotfun-sdk";
import { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import { AnchorProvider } from "@coral-xyz/anchor";
import NodeWallet from "@coral-xyz/anchor/dist/cjs/nodewallet";
import * as readline from 'readline';
import dotenv from 'dotenv';
import chalk from 'chalk';
import bs58 from 'bs58';
import WebSocket from 'ws';
import fetch from 'node-fetch';
import { WalletStorage } from './WalletStorage';


interface TokenInfo {
    mint: PublicKey;
    name: string;
    symbol: string;
    balance: number;
    marketCapUSD: string;
    valueUSD: string;
    lastUpdated: Date;
}

interface TokenMetadata {
    name: string;
    symbol: string;
    metadataUri: string;
}

interface PumpFunTokenResponse {
    name?: string;
    symbol?: string;
}

interface PumpFunTokenData {
    name?: string;
    projectName?: string;
}

interface WSMessage {
    jsonrpc: string;
    method: string;
    params?: any;
    id?: number;
}

interface PriorityFee {
    unitPrice: number;
    unitLimit: number;
}

interface PumpFunApiResponse {
    name?: string;
    symbol?: string;
}

class PumpFunBot {
    private sdk: PumpFunSDK;
    private connection: Connection;
    private wallet: Keypair;
    private rl: readline.Interface;
    private solPriceUSD: number = 0;
    private ws: WebSocket;
    private tokenDataCache: Map<string, TokenInfo> = new Map();
    private walletStorage: WalletStorage;

    constructor() {
        console.log('Loading environment variables...');
        dotenv.config();

        if (!process.env.HELIUS_RPC_URL) {
            throw new Error("HELIUS_RPC_URL not found in .env file");
        }
        if (!process.env.HELIUS_WS_URL) {
            throw new Error("HELIUS_WS_URL not found in .env file");
        }
        if (!process.env.PHANTOM_KEY) {
            throw new Error("PHANTOM_KEY not found in .env file");
        }

        try {
            const secretKey = bs58.decode(process.env.PHANTOM_KEY);
            this.wallet = Keypair.fromSecretKey(secretKey);
            
            if (secretKey.length !== 64) {
                throw new Error("Invalid private key length");
            }

            this.connection = new Connection(process.env.HELIUS_RPC_URL);
            this.walletStorage = new WalletStorage()
            
            const provider = new AnchorProvider(
                this.connection,
                new NodeWallet(this.wallet),
                { commitment: "confirmed" }
            );
            this.sdk = new PumpFunSDK(provider);

            this.rl = readline.createInterface({
                input: process.stdin,
                output: process.stdout
            });

            // Initialize WebSocket
            this.ws = new WebSocket(process.env.HELIUS_WS_URL);
            this.setupWebSocket();

        } catch (error) {
            console.error(chalk.red("Error initializing bot:"), error);
            process.exit(1);
        }
    }

    private setupWebSocket() {
        this.ws.on('open', () => {
            console.log(chalk.green('\nWebSocket connected'));
            this.subscribeToTokenUpdates();
        });

        this.ws.on('message', async (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString()) as WSMessage;
                await this.handleWebSocketMessage(message);
            } catch (error) {
                console.error('Error processing WebSocket message:', error);
            }
        });

        this.ws.on('error', (error) => {
            console.error('WebSocket error:', error);
        });

        this.ws.on('close', () => {
            console.log(chalk.yellow('\nWebSocket connection closed. Attempting to reconnect...'));
            setTimeout(() => this.setupWebSocket(), 5000);
        });
    }

    private subscribeToTokenUpdates() {
        const subscribeMessage: WSMessage = {
            jsonrpc: '2.0',
            method: 'tokenAccountSubscribe',
            params: [
                this.wallet.publicKey.toString(),
                {
                    commitment: 'confirmed',
                    encoding: 'jsonParsed'
                }
            ],
            id: 1
        };

        this.ws.send(JSON.stringify(subscribeMessage));
    }

    private async handleWebSocketMessage(message: WSMessage) {
        if (message.method === 'tokenAccountNotification') {
            const tokenData = message.params?.result?.value;
            if (tokenData) {
                await this.updateTokenCache(tokenData);
                await this.displayMenu(); // Refresh display
            }
        }
    }

    private async updateTokenCache(tokenData: any) {
        const mint = new PublicKey(tokenData.mint);
        const existingData = this.tokenDataCache.get(mint.toString());

        try {
            const bondingCurve = await this.sdk.getBondingCurveAccount(mint);
            const globalAccount = await this.sdk.getGlobalAccount();

            if (bondingCurve) {
                const marketCapSOL = Number(bondingCurve.getMarketCapSOL());
                const marketCapUSD = marketCapSOL * this.solPriceUSD;
                const balance = Number(tokenData.tokenAmount.amount);
                const valueUSD = (marketCapUSD * balance) / Number(globalAccount.tokenTotalSupply);

                this.tokenDataCache.set(mint.toString(), {
                    mint,
                    name: existingData?.name || `Token-${mint.toString().slice(0, 4)}`,
                    symbol: existingData?.symbol || `TKN-${mint.toString().slice(0, 4)}`,
                    balance: balance / Math.pow(10, 6),
                    marketCapUSD: `$${marketCapUSD.toFixed(2)}`,
                    valueUSD: `$${valueUSD.toFixed(2)}`,
                    lastUpdated: new Date()
                });
            }
        } catch (error) {
            console.error(`Error updating token cache for ${mint.toString()}:`, error);
        }
    }

    private async getSolanaPrice(): Promise<number> {
        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            const data = await response.json() as { solana: { usd: number } };
            return data.solana.usd;
        } catch (error) {
            console.error('Error fetching SOL price:', error);
            return 0;
        }
    }

    private async getTokenName(mint: PublicKey): Promise<{ name: string; symbol: string }> {
        try {
            // First verify it's a pump.fun token
            const bondingCurve = await this.sdk.getBondingCurveAccount(mint);
            if (bondingCurve) {
                try {
                    // Attempt to get token info from API
                    const response = await fetch(`https://pump.fun/api/projects/${mint.toString()}`, {
                        headers: {
                            'Accept': 'application/json',
                            'Content-Type': 'application/json'
                        }
                    });
    
                    // Check if response is ok and has content
                    if (response.ok) {
                        const text = await response.text();
                        if (text && text.trim()) {
                            try {
                                const data = JSON.parse(text) as PumpFunTokenData;
                                if (data?.projectName) {
                                    const tokenName = data.projectName.toUpperCase();
                                    return {
                                        name: tokenName,
                                        symbol: tokenName
                                    };
                                }
                            } catch (jsonError) {
                                console.debug(`JSON parse error: ${jsonError}`);
                            }
                        }
                    }
    
                    // Try alternative endpoint for specific tokens
                    const knownTokens: Record<string, string> = {
                        "5jjTz3tT1agIGzCN4yqGnaSKFSDuN6ZmmwHsTmHgpump": "STELLA",
                        "8957eALoxZxGPwNaMN73FTU7TJ7tmyzUzvgFHY1Fpump": "CHADGUY"
                    };
    
                    const tokenName = knownTokens[mint.toString()];
                    if (tokenName) {
                        return {
                            name: tokenName,
                            symbol: tokenName
                        };
                    }
    
                } catch (apiError) {
                    console.debug(`API error: ${apiError}`);
                }
            }
    
            // Fallback
            return {
                name: `Token-${mint.toString().slice(0, 4)}`,
                symbol: `${mint.toString().slice(0, 4)}`
            };
    
        } catch (error) {
            console.error(`Error in getTokenName: ${error}`);
            return {
                name: `Token-${mint.toString().slice(0, 4)}`,
                symbol: `${mint.toString().slice(0, 4)}`
            };
        }
    }

    async getAllTokenAccounts(): Promise<TokenInfo[]> {
        try {
            this.solPriceUSD = await this.getSolanaPrice();
    
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.wallet.publicKey,
                { programId: TOKEN_PROGRAM_ID }
            );
    
            const tokens = await Promise.all(tokenAccounts.value
                .filter(account => Number(account.account.data.parsed.info.tokenAmount.amount) > 0)
                .map(async (account) => {
                    const mint = new PublicKey(account.account.data.parsed.info.mint);
                    const cachedData = this.tokenDataCache.get(mint.toString());
                    
                    if (cachedData) {
                        return cachedData;
                    }
    
                    try {
                        const bondingCurve = await this.sdk.getBondingCurveAccount(mint);
                        const globalAccount = await this.sdk.getGlobalAccount();
                        
                        if (bondingCurve) {
                            const { name, symbol } = await this.getTokenName(mint);
                            
                            const marketCapSOL = Number(bondingCurve.getMarketCapSOL()) / 1e9;
                            const marketCapUSD = marketCapSOL * this.solPriceUSD;
                            const balance = Number(account.account.data.parsed.info.tokenAmount.amount);
                            const totalSupply = Number(globalAccount.tokenTotalSupply);
                            const ownershipPercentage = balance / totalSupply;
                            const valueUSD = marketCapUSD * ownershipPercentage;
                        
                            const tokenInfo: TokenInfo = {
                                mint,
                                name,
                                symbol,
                                balance: balance / Math.pow(10, 6),
                                marketCapUSD: `$${marketCapUSD.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2
                                })}`,
                                valueUSD: `$${valueUSD.toLocaleString(undefined, {
                                    minimumFractionDigits: 2,
                                    maximumFractionDigits: 2
                                })}`,
                                lastUpdated: new Date()
                            };
                        
                            this.tokenDataCache.set(mint.toString(), tokenInfo);
                            return tokenInfo;
                        }
                    } catch (error) {
                        console.error(`Error fetching data for token ${mint.toString()}:`, error);
                    }
                    return null;
                }));
    
            return tokens.filter((token): token is TokenInfo => token !== null);
        } catch (error) {
            console.error(chalk.red('Error fetching token accounts:'), error);
            return [];
        }
    }

    async displayPortfolio() {
    console.log(chalk.blue('\nFetching your token portfolio...'));
    
    const tokens = await this.getAllTokenAccounts();
    
    if (tokens.length === 0) {
        console.log(chalk.yellow('\nNo tokens found in wallet'));
        return;
    }

    // Define column widths
    const columns = {
        token: 15,      // Reduced width since we're only showing "Stella"
        balance: 20,
        marketCap: 20,
        value: 15,
        lastUpdated: 15,
        address: 45
    };

    console.log(chalk.blue('\nYour Token Portfolio:'));
    console.log(chalk.gray('═'.repeat(135)));  // Reduced total width
    
    // Header
    console.log(
        chalk.cyan(
            'Token'.padEnd(columns.token) +
            'Balance'.padEnd(columns.balance) +
            'Market Cap'.padEnd(columns.marketCap) +
            'Value'.padEnd(columns.value) +
            'Last Updated'.padEnd(columns.lastUpdated) +
            'Contract Address'
        )
    );
    console.log(chalk.gray('═'.repeat(135)));  // Reduced total width

    // Data rows
    tokens.forEach((token: TokenInfo) => {
        console.log(
            token.name.padEnd(columns.token) +
            `${token.balance.toLocaleString(undefined, {
                minimumFractionDigits: 6,
                maximumFractionDigits: 6
            })}`.padEnd(columns.balance) +
            `${token.marketCapUSD}`.padEnd(columns.marketCap) +
            `${token.valueUSD}`.padEnd(columns.value) +
            `${token.lastUpdated.toLocaleTimeString()}`.padEnd(columns.lastUpdated) +
            `${token.mint.toString()}`
        );
    });
    
    console.log(chalk.gray('═'.repeat(135)));  // Reduced total width
}

    async displaySOLBalance(): Promise<void> {
        try {
            const balance = await this.connection.getBalance(this.wallet.publicKey);
            console.log(chalk.green(`\nSOL Balance: ${balance / 1e9} SOL`));
        } catch (error) {
            console.error(chalk.red('Error getting SOL balance:'), error);
        }
    }

    async displayMenu() {
        console.clear();
        console.log(chalk.blue('=== Pump.fun Trading Bot ==='));
        console.log(chalk.green(`Connected Wallet: ${this.wallet.publicKey.toString()}`));
        await this.displaySOLBalance();
        await this.displayPortfolio();
        
        console.log('\nOptions:');
        console.log('1. Refresh Portfolio');
        console.log('2. Buy Tokens');
        console.log('3. Sell Tokens');
        console.log('4. Monitor Token');
        console.log('5. View Active Trades');
        console.log('6. Settings');
        console.log('7. Wallet Management');
        console.log('8. Exit');
        
        // Create a new readline question instead of reusing the existing one
        return new Promise<void>((resolve) => {
            this.rl.question('\nSelect an option (1-8): ', async (answer) => {
                switch (answer) {
                    case '1':
                        await this.displayMenu();
                        break;
                    case '2':
                        await this.executeBuySwap();
                        break;
                    case '3':
                        await this.executeSellSwap();
                        break;
                    case '4':
                        await this.monitorToken();
                        break;
                    case '5':
                        await this.viewActiveTrades();
                        break;
                    case '6':
                        await this.showSettings();
                        break;
                    case '7':
                        await this.showWalletManagement();
                        break;
                    case '8':
                        console.log(chalk.yellow('\nExiting bot...'));
                        await this.cleanup();
                        process.exit(0);
                    default:
                        console.log(chalk.red('\nInvalid option!'));
                        await this.waitForInput();
                        await this.displayMenu();
                }
                resolve();
            });
        });
    }

    private async showWalletManagement() {
        console.clear();
        console.log(chalk.blue('=== Wallet Management ===\n'));
        
        console.log('1. View Connected Wallets');
        console.log('2. Generate New Wallets');
        console.log('3. Fund Wallet');
        console.log('4. Fund All Wallets');
        console.log('5. Transfer Tokens to Main');
        console.log('6. Delete Wallet');
        console.log('7. Delete All Wallets');
        console.log('8. Execute Trades');  // New option
        console.log('9. Back to Main Menu');
        
        return new Promise<void>((resolve) => {
            this.rl.question('\nSelect an option (1-9): ', async (answer) => {
                switch (answer) {
                    case '1':
                        await this.displayWallets();
                        break;
                    case '2':
                        await this.generateWallets();
                        break;
                    case '3':
                        await this.fundWallet();
                        break;
                    case '4':
                        await this.fundAllWallets();
                        break;
                    case '5':
                        await this.transferTokensToMain();
                        break;
                    case '6':
                        await this.deleteWallet();
                        break;
                    case '7':
                        await this.deleteAllWallets();
                        break;
                    case '8':
                            await this.executeWalletTrades();
                            break;    
                    case '9':
                        await this.displayMenu();
                        break;
                    default:
                        console.log(chalk.red('\nInvalid option!'));
                        await this.waitForInput();
                        await this.showWalletManagement();
                }
                resolve();
            });
        });
    }

    private async fundWallet() {
        console.clear();
        console.log(chalk.blue('=== Fund Wallet ===\n'));
    
        const wallets = this.walletStorage.getAllWallets();
        if (wallets.length === 0) {
            console.log(chalk.yellow('No wallets found to fund.'));
            await this.waitForInput();
            await this.showWalletManagement();
            return;
        }
    
        this.displayWalletList(wallets);
    
        return new Promise<void>((resolve) => {
            this.rl.question('\nEnter the number of the wallet to fund (or 0 to cancel): ', async (answer) => {
                const index = parseInt(answer) - 1;
                
                if (answer === '0') {
                    await this.showWalletManagement();
                    resolve();
                    return;
                }
    
                if (isNaN(index) || index < 0 || index >= wallets.length) {
                    console.log(chalk.red('\nInvalid wallet number!'));
                    await this.waitForInput();
                    await this.showWalletManagement();
                    resolve();
                    return;
                }
    
                const selectedWallet = wallets[index];
                this.rl.question('Enter amount of SOL to send: ', async (amount) => {
                    const solAmount = parseFloat(amount);
                    if (isNaN(solAmount) || solAmount <= 0) {
                        console.log(chalk.red('\nInvalid amount!'));
                    } else {
                        const success = await this.walletStorage.fundWallet(
                            this.connection,
                            this.wallet,
                            selectedWallet.publicKey,
                            solAmount
                        );
    
                        if (success) {
                            console.log(chalk.green(`\nSuccessfully funded wallet with ${solAmount} SOL`));
                        } else {
                            console.log(chalk.red('\nFailed to fund wallet'));
                        }
                    }
                    await this.waitForInput();
                    await this.showWalletManagement();
                    resolve();
                });
            });
        });
    }

    private async executeWalletTrades() {
        console.clear();
        console.log(chalk.blue('=== Execute Trades ===\n'));
    
        const wallets = this.walletStorage.getAllWallets();
        if (wallets.length === 0) {
            console.log(chalk.yellow('No wallets found.'));
            await this.waitForInput();
            await this.showWalletManagement();
            return;
        }
    
        this.displayWalletList(wallets);
    
        return new Promise<void>((resolve) => {
            this.rl.question(
                '\nEnter the number of the wallet to trade from (0 to cancel, "all" for all wallets): ',
                async (walletAnswer) => {
                    if (walletAnswer === '0') {
                        await this.showWalletManagement();
                        resolve();
                        return;
                    }
    
                    const useAllWallets = walletAnswer.toLowerCase() === 'all';
                    const walletIndex = parseInt(walletAnswer) - 1;
    
                    if (!useAllWallets && (isNaN(walletIndex) || walletIndex < 0 || walletIndex >= wallets.length)) {
                        console.log(chalk.red('\nInvalid wallet selection'));
                        await this.waitForInput();
                        await this.showWalletManagement();
                        resolve();
                        return;
                    }
    
                    this.rl.question('\nEnter the token contract address: ', async (tokenAddress) => {
                        try {
                            const tokenMint = new PublicKey(tokenAddress);
                            
                            this.rl.question('\nEnter amount of SOL to spend per wallet: ', async (amountStr) => {
                                const solAmount = parseFloat(amountStr);
                                if (isNaN(solAmount) || solAmount <= 0) {
                                    console.log(chalk.red('\nInvalid amount'));
                                    await this.waitForInput();
                                    await this.showWalletManagement();
                                    resolve();
                                    return;
                                }
    
                                this.rl.question('\nEnter slippage (default 5%): ', async (slippageStr) => {
                                    const slippage = slippageStr ? parseFloat(slippageStr) : 5;
    
                                    this.rl.question('\nEnter priority fee (optional): ', async (priorityFeeStr) => {
                                        let priorityFee;
                                        if (priorityFeeStr) {
                                            const fee = parseFloat(priorityFeeStr);
                                            if (!isNaN(fee)) {
                                                priorityFee = {
                                                    unitPrice: fee,
                                                    unitLimit: 250000,
                                                };
                                            }
                                        }
    
                                        console.log(chalk.yellow('\nExecuting trades... This may take a moment.'));
    
                                        try {
                                            if (useAllWallets) {
                                                const results = await this.walletStorage.executeBuyFromAllWallets(
                                                    this.connection,
                                                    this.sdk,
                                                    tokenMint,
                                                    solAmount,
                                                    slippage,
                                                    priorityFee
                                                );
    
                                                if (results.success) {
                                                    console.log(chalk.green('\nAll trades completed successfully'));
                                                } else {
                                                    console.log(chalk.yellow('\nSome trades failed - check above for details'));
                                                }
                                            } else {
                                                const selectedWallet = wallets[walletIndex];
                                                const result = await this.walletStorage.executeBuyFromWallet(
                                                    this.connection,
                                                    this.sdk,
                                                    selectedWallet.publicKey,
                                                    tokenMint,
                                                    solAmount,
                                                    slippage,
                                                    priorityFee
                                                );
    
                                                if (result.success) {
                                                    console.log(chalk.green('\nTrade completed successfully'));
                                                    console.log('Transaction signature:', result.signature);
                                                } else {
                                                    console.log(chalk.red('\nTrade failed:', result.error));
                                                }
                                            }
                                        } catch (error) {
                                            console.error(chalk.red('\nError executing trades:'), error);
                                        }
    
                                        await this.waitForInput();
                                        await this.showWalletManagement();
                                        resolve();
                                    });
                                });
                            });
                        } catch (error) {
                            console.error(chalk.red('\nInvalid token address'));
                            await this.waitForInput();
                            await this.showWalletManagement();
                            resolve();
                        }
                    });
                }
            );
        });
    }
    
    private async fundAllWallets() {
        console.clear();
        console.log(chalk.blue('=== Fund All Wallets ===\n'));
    
        const wallets = this.walletStorage.getAllWallets();
        if (wallets.length === 0) {
            console.log(chalk.yellow('No wallets found to fund.'));
            await this.waitForInput();
            await this.showWalletManagement();
            return;
        }
    
        console.log(chalk.yellow(`Number of wallets to fund: ${wallets.length}`));
    
        return new Promise<void>((resolve) => {
            this.rl.question('Enter amount of SOL to send to each wallet: ', async (amount) => {
                const solAmount = parseFloat(amount);
                if (isNaN(solAmount) || solAmount <= 0) {
                    console.log(chalk.red('\nInvalid amount!'));
                } else {
                    const totalAmount = solAmount * wallets.length;
                    this.rl.question(
                        chalk.yellow(`\nThis will send ${totalAmount} SOL in total. Continue? (y/n): `),
                        async (confirm) => {
                            if (confirm.toLowerCase() === 'y') {
                                const success = await this.walletStorage.fundAllWallets(
                                    this.connection,
                                    this.wallet,
                                    solAmount
                                );
    
                                if (success) {
                                    console.log(chalk.green(`\nSuccessfully funded all wallets with ${solAmount} SOL each`));
                                } else {
                                    console.log(chalk.red('\nFailed to fund wallets'));
                                }
                            } else {
                                console.log(chalk.yellow('\nOperation cancelled'));
                            }
                            await this.waitForInput();
                            await this.showWalletManagement();
                            resolve();
                        }
                    );
                }
            });
        });
    }
    
    private async transferTokensToMain() {
        console.clear();
        console.log(chalk.blue('=== Transfer to Main Wallet ===\n'));
    
        const wallets = this.walletStorage.getAllWallets();
        if (wallets.length === 0) {
            console.log(chalk.yellow('No wallets found.'));
            await this.waitForInput();
            await this.showWalletManagement();
            return;
        }
    
        this.displayWalletList(wallets);
    
        console.log('\nTransfer Options:');
        console.log('1. Transfer Specific Token');
        console.log('2. Transfer SOL');
        console.log('3. Transfer All Assets');
        console.log('4. Back to Wallet Management');
    
        return new Promise<void>((resolve) => {
            this.rl.question('\nSelect an option (1-4): ', async (option) => {
                const walletPrompt = async () => {
                    return new Promise<number>((resolveWallet) => {
                        this.rl.question(
                            '\nEnter the number of the wallet to transfer from (0 to cancel, "all" for all wallets): ',
                            answer => {
                                if (answer.toLowerCase() === 'all') return -2;
                                return parseInt(answer) - 1;
                            }
                        );
                    });
                };
    
                switch (option) {
                    case '1': {
                        const index = await walletPrompt();
                        if (index === -1) {
                            await this.showWalletManagement();
                            resolve();
                            return;
                        }
    
                        if (index === -2) {
                            console.log(chalk.yellow('\nPlease select a specific wallet for token transfers.'));
                            await this.waitForInput();
                            await this.showWalletManagement();
                            resolve();
                            return;
                        }
    
                        if (index >= wallets.length) {
                            console.log(chalk.red('\nInvalid wallet selection'));
                            break;
                        }
    
                        this.rl.question('Enter token mint address: ', async (mintAddress) => {
                            try {
                                const selectedWallet = wallets[index];
                                const tokenMint = new PublicKey(mintAddress);
    
                                const success = await this.walletStorage.transferTokensToMain(
                                    this.connection,
                                    this.sdk,
                                    selectedWallet.publicKey,
                                    this.wallet,
                                    tokenMint
                                );
    
                                console.log(success
                                    ? chalk.green('\nSuccessfully transferred tokens')
                                    : chalk.red('\nFailed to transfer tokens'));
                            } catch (error) {
                                console.error(chalk.red('\nError:'), error);
                            }
                            await this.waitForInput();
                            await this.showWalletManagement();
                            resolve();
                        });
                        break;
                    }
    
                    case '2':
                    case '3': {
                        const index = await walletPrompt();
                        if (index === -1) {
                            await this.showWalletManagement();
                            resolve();
                            return;
                        }
    
                        try {
                            if (index === -2) {
                                // Transfer from all wallets
                                console.log(chalk.yellow('\nTransferring from all wallets... This may take a moment.'));
                                const success = await this.walletStorage.transferAllWalletsToMain(
                                    this.connection,
                                    this.sdk,
                                    this.wallet
                                );
                                console.log(success
                                    ? chalk.green('\nSuccessfully transferred assets from all wallets')
                                    : chalk.red('\nSome transfers failed, check the logs above'));
                            } else if (index < wallets.length) {
                                const selectedWallet = wallets[index];
                                if (option === '2') {
                                    this.rl.question('Enter amount of SOL to transfer (press Enter for max): ', async (amount) => {
                                        const solAmount = amount ? parseFloat(amount) : undefined;
                                        const success = await this.walletStorage.transferSolToMain(
                                            this.connection,
                                            selectedWallet.publicKey,
                                            this.wallet,
                                            solAmount
                                        );
                                        console.log(success
                                            ? chalk.green('\nSuccessfully transferred SOL')
                                            : chalk.red('\nFailed to transfer SOL'));
                                        await this.waitForInput();
                                        await this.showWalletManagement();
                                        resolve();
                                    });
                                    return;
                                } else {
                                    console.log(chalk.yellow('\nTransferring all assets... This may take a moment.'));
                                    const success = await this.walletStorage.transferAllToMain(
                                        this.connection,
                                        this.sdk,
                                        selectedWallet.publicKey,
                                        this.wallet
                                    );
                                    console.log(success
                                        ? chalk.green('\nSuccessfully transferred all assets')
                                        : chalk.red('\nFailed to transfer assets'));
                                }
                            } else {
                                console.log(chalk.red('\nInvalid wallet selection'));
                            }
                        } catch (error) {
                            console.error(chalk.red('\nError:'), error);
                        }
                        await this.waitForInput();
                        await this.showWalletManagement();
                        resolve();
                        break;
                    }
    
                    case '4':
                    default:
                        await this.showWalletManagement();
                        resolve();
                        break;
                }
            });
        });
    }

    private async deleteWallet() {
        console.clear();
        console.log(chalk.blue('=== Delete Wallet ===\n'));
    
        const wallets = this.walletStorage.getAllWallets();
        if (wallets.length === 0) {
            console.log(chalk.yellow('No wallets found to delete.'));
            await this.waitForInput();
            await this.showWalletManagement();
            return;
        }
    
        // Display wallets first
        this.displayWalletList(wallets);
    
        return new Promise<void>((resolve) => {
            this.rl.question('\nEnter the number of the wallet to delete (or 0 to cancel): ', async (answer) => {
                const index = parseInt(answer) - 1;
                
                if (answer === '0') {
                    await this.showWalletManagement();
                    resolve();
                    return;
                }
    
                if (isNaN(index) || index < 0 || index >= wallets.length) {
                    console.log(chalk.red('\nInvalid wallet number!'));
                    await this.waitForInput();
                    await this.showWalletManagement();
                    resolve();
                    return;
                }
    
                const selectedWallet = wallets[index];
                this.rl.question(
                    chalk.yellow(`\nAre you sure you want to delete wallet ${selectedWallet.publicKey.slice(0, 8)}...? (y/n): `),
                    async (confirm) => {
                        if (confirm.toLowerCase() === 'y') {
                            // Fixed this line to call the correct method
                            const success = this.walletStorage.deleteWallet(selectedWallet.publicKey);
                            if (success) {
                                console.log(chalk.green('\nWallet deleted successfully!'));
                            } else {
                                console.log(chalk.red('\nFailed to delete wallet.'));
                            }
                        } else {
                            console.log(chalk.yellow('\nDeletion cancelled.'));
                        }
                        await this.waitForInput();
                        await this.showWalletManagement();
                        resolve();
                    }
                );
            });
        });
    }
    
    private async deleteAllWallets() {
        console.clear();
        console.log(chalk.blue('=== Delete All Wallets ===\n'));
    
        const wallets = this.walletStorage.getAllWallets();
        if (wallets.length === 0) {
            console.log(chalk.yellow('No wallets found to delete.'));
            await this.waitForInput();
            await this.showWalletManagement();
            return;
        }
    
        console.log(chalk.red('WARNING: This will delete all generated wallets!'));
        console.log(chalk.yellow(`Number of wallets to be deleted: ${wallets.length}`));
    
        return new Promise<void>((resolve) => {
            this.rl.question(
                chalk.yellow('\nAre you sure you want to delete all wallets? (type "DELETE" to confirm): '),
                async (confirm) => {
                    if (confirm === 'DELETE') {
                        const success = this.walletStorage.deleteAllWallets();
                        if (success) {
                            console.log(chalk.green('\nAll wallets deleted successfully!'));
                        } else {
                            console.log(chalk.red('\nFailed to delete all wallets.'));
                        }
                    } else {
                        console.log(chalk.yellow('\nDeletion cancelled.'));
                    }
                    await this.waitForInput();
                    await this.showWalletManagement();
                    resolve();
                }
            );
        });
    }
    
    private displayWalletList(wallets: any[]) {
        // Define column widths
        const columns = {
            index: 6,
            label: 20,
            publicKey: 45,
            balance: 15,
            lastUsed: 25
        };
    
        // Print header
        console.log(
            'Index'.padEnd(columns.index) +
            'Label'.padEnd(columns.label) +
            'Public Key'.padEnd(columns.publicKey) +
            'Balance (SOL)'.padEnd(columns.balance) +
            'Last Used'
        );
        console.log('═'.repeat(110));
    
        // Print wallet information
        wallets.forEach((wallet, index) => {
            console.log(
                `${(index + 1).toString().padEnd(columns.index)}` +
                `${(wallet.label || 'N/A').padEnd(columns.label)}` +
                `${wallet.publicKey.slice(0, 40) + '...'.padEnd(columns.publicKey - 40)}` +
                `${(wallet.balance?.toString() || '0').padEnd(columns.balance)}` +
                `${wallet.lastUsed ? new Date(wallet.lastUsed).toLocaleString() : 'Never'}`
            );
        });
    }

    private async displayWallets() {
        console.clear();
        console.log(chalk.blue('=== Connected Wallets ===\n'));
    
        const wallets = this.walletStorage.getAllWallets();
        if (wallets.length === 0) {
            console.log(chalk.yellow('No wallets found. Use option 2 to generate new wallets.'));
        } else {
            // Define column widths
            const columns = {
                index: 6,
                label: 20,
                publicKey: 45,
                balance: 15,
                tokens: 25,
                lastUsed: 25
            };
    
            // Print header
            console.log(
                'Index'.padEnd(columns.index) +
                'Label'.padEnd(columns.label) +
                'Public Key'.padEnd(columns.publicKey) +
                'Balance (SOL)'.padEnd(columns.balance) +
                'Token Value (USD)'.padEnd(columns.tokens) +
                'Last Used'
            );
            console.log('═'.repeat(135));
    
            // Print wallet information
            for (const wallet of wallets) {
                const tokenValues = await this.walletStorage.getWalletTokenValues(
                    this.connection,
                    this.sdk,
                    wallet.publicKey
                );
    
                const tokenValueStr = tokenValues.tokenCount > 0
                    ? `$${tokenValues.totalTokenValueUSD.toFixed(2)} (${tokenValues.tokenCount})`
                    : 'No tokens';
    
                console.log(
                    `${wallets.indexOf(wallet) + 1}`.padEnd(columns.index) +
                    `${(wallet.label || 'N/A').padEnd(columns.label)}` +
                    `${wallet.publicKey.slice(0, 40) + '...'.padEnd(columns.publicKey - 40)}` +
                    `${(wallet.balance?.toString() || '0').padEnd(columns.balance)}` +
                    `${tokenValueStr.padEnd(columns.tokens)}` +
                    `${wallet.lastUsed ? new Date(wallet.lastUsed).toLocaleString() : 'Never'}`
                );
            }
        }
    
        await this.waitForInput();
        await this.showWalletManagement();
    }

    private async generateWallets() {
        console.clear();
        console.log(chalk.blue('=== Generate New Wallets ===\n'));

        this.rl.question('How many wallets would you like to generate? ', async (countStr) => {
            const count = parseInt(countStr);
            
            if (isNaN(count) || count <= 0) {
                console.log(chalk.red('\nPlease enter a valid number greater than 0'));
                await this.waitForInput();
                await this.showWalletManagement();
                return;
            }

            this.rl.question('Enter a label prefix for the wallets (optional): ', async (labelPrefix) => {
                console.log(chalk.yellow('\nGenerating wallets...'));

                try {
                    for (let i = 0; i < count; i++) {
                        const keypair = Keypair.generate();
                        const label = labelPrefix ? `${labelPrefix}-${i + 1}` : undefined;
                        
                        const storedWallet = this.walletStorage.storeWallet(keypair, label);
                        
                        // Attempt to get initial balance
                        try {
                            const balance = await this.connection.getBalance(keypair.publicKey);
                            this.walletStorage.updateWalletBalance(
                                storedWallet.publicKey, 
                                balance / LAMPORTS_PER_SOL
                            );
                        } catch (error) {
                            console.error(chalk.red(`Error fetching balance for wallet ${i + 1}`));
                        }

                        console.log(chalk.green(
                            `Generated wallet ${i + 1}/${count}: ${storedWallet.publicKey.slice(0, 8)}...`
                        ));
                    }

                    console.log(chalk.green('\nWallet generation complete!'));
                    console.log(chalk.yellow('The wallet files are stored in the "wallets" directory'));
                } catch (error) {
                    console.error(chalk.red('\nError generating wallets:'), error);
                }

                await this.waitForInput();
                await this.showWalletManagement();
            });
        });
    }

    private async executeBuySwap() {
        try {
            const pumpfunMintAddress = await new Promise<string>((resolve) => {
                this.rl.question('\nEnter the PumpFun token contract address: ', resolve);
            });

            const amountSol = await new Promise<string>((resolve) => {
                this.rl.question('\nEnter amount of SOL to spend: ', resolve);
            });

            const slippage = await new Promise<string>((resolve) => {
                this.rl.question('\nEnter slippage (default 5%): ', resolve);
            });

            let priorityFeeInput = await new Promise<string>((resolve) => {
                this.rl.question('\nEnter priority fee (optional): ', resolve);
            });

            let priorityFee: PriorityFee | undefined;
            if (priorityFeeInput.trim() !== '') {
                const priorityFeeAmount = parseFloat(priorityFeeInput);
                priorityFee = {
                    unitPrice: priorityFeeAmount,
                    unitLimit: 250000,
                };
            }

            console.log('\nVerifying wallet and connection...');
            const walletBalance = await this.connection.getBalance(this.wallet.publicKey);
            console.log('Current wallet balance:', walletBalance / 1e9, 'SOL');

            const sol = parseFloat(amountSol);
            if (walletBalance < sol * 1e9) {
                throw new Error('Insufficient balance for transaction');
            }

            const buyResults = await this.sdk.buy(
                this.wallet,
                new PublicKey(pumpfunMintAddress),
                BigInt(sol * 1e9), // Convert to program units
                BigInt(parseFloat(slippage || "5") * 100), // Slippage in basis points
                priorityFee, // Pass the PriorityFee object
                "finalized" // Commitment level
            );

            if (buyResults.success) {
                console.log(chalk.green('\nBuy successful!'));
                console.log('Transaction signature:', buyResults.signature);

                // Wait and refresh portfolio
                await new Promise(resolve => setTimeout(resolve, 2000));
                await this.displayPortfolio();
            } else {
                console.error(chalk.red('\nBuy failed:'), buyResults.error);
            }
        } catch (error) {
            console.error(chalk.red('\nError executing buy swap:'), error);
        }
        await this.waitForInput();
    }

    private async executeSellSwap() {
        try {
            const pumpfunMintAddress = await new Promise<string>((resolve) => {
                this.rl.question('\nEnter the PumpFun token contract address: ', resolve);
            });

            const amount = await new Promise<string>((resolve) => {
                this.rl.question('\nEnter amount of PumpFun tokens to sell: ', resolve);
            });

            const slippage = await new Promise<string>((resolve) => {
                this.rl.question('\nEnter slippage (default 5%): ', resolve);
            });

            // Convert inputs
            const mint = new PublicKey(pumpfunMintAddress);
            const sellTokenAmount = BigInt(parseFloat(amount) * 1e6); // Convert to token decimals
            const slippageBasisPoints = BigInt(parseFloat(slippage || "5") * 100);

            console.log(chalk.yellow('\nExecuting sell swap...'));

            const sellResults = await this.sdk.sell(
                this.wallet,
                mint,
                sellTokenAmount,
                slippageBasisPoints,
                undefined, // priorityFees
                "finalized" // commitment
            );

            if (sellResults.success) {
                console.log(chalk.green('\nSell successful!'));
                console.log('Transaction signature:', sellResults.signature);

                // Wait and refresh portfolio
                await new Promise(resolve => setTimeout(resolve, 2000));
                await this.displayPortfolio();
            } else {
                console.error(chalk.red('\nSell failed:'), sellResults.error);
            }
        } catch (error) {
            console.error(chalk.red('\nError executing sell swap:'), error);
        }
        await this.waitForInput();
    }


    private async monitorToken() {
        console.log(chalk.yellow('\nToken monitoring coming soon...'));
        await this.waitForInput();
    }


    private async viewActiveTrades() {
        console.log(chalk.yellow('\nActive trades view coming soon...'));
        await this.waitForInput();
    }

    private async showSettings() {
        console.log(chalk.yellow('\nSettings module coming soon...'));
        await this.waitForInput();
    }

    private async waitForInput(): Promise<void> {
        return new Promise<void>((resolve) => {
            this.rl.question('\nPress Enter to continue...', () => {
                resolve();
            });
        });
    }

    public async cleanup() {
        if (this.ws) {
            this.ws.close();
        }
        this.rl.close();
    }

    public start() {
        this.displayMenu();
    }

}

// Start the bot
try {
    const bot = new PumpFunBot();
    
    // Handle cleanup on exit
    process.on('SIGINT', async () => {
        await bot.cleanup();
        process.exit(0);
    });

    bot.start();
} catch (error) {
    console.error(chalk.red("Failed to start bot:"), error);
    process.exit(1);
}