import { Transaction, SystemProgram, PublicKey, Keypair, Connection, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { PumpFunSDK } from "pumpdotfun-sdk";
import { getAccount, getAssociatedTokenAddress, TOKEN_PROGRAM_ID } from "@solana/spl-token";
import chalk from 'chalk';
import * as fs from 'fs';
import * as path from 'path';

interface StoredWallet {
    publicKey: string;
    privateKey: string;
    label?: string;
    createdAt: Date;
    lastUsed?: Date;
    balance?: number;
}

interface CopyTradeConfig {
    enabled: boolean;
    slippageMultiplier: number;
    solAmountMultiplier: number;
    maxSolPerTrade: number;
    priorityFeeMultiplier: number;
}

interface SDKBuyResult {
    success: boolean;
    signature?: string;
    error?: string | { message: string };
}

interface BuyResults {
    success: boolean;
    signature?: string;
    error?: string;
}

interface TradeError {
    message: string;
}

export class WalletStorage {
    private walletsDir: string;
    private wallets: Map<string, StoredWallet>;

    constructor() {
        this.walletsDir = path.join(process.cwd(), 'wallets');
        this.wallets = new Map();
        this.initializeStorage();
    }

    private initializeStorage(): void {
        // Create wallets directory if it doesn't exist
        if (!fs.existsSync(this.walletsDir)) {
            fs.mkdirSync(this.walletsDir, { recursive: true });
        }

        // Load existing wallets
        this.loadWallets();
    }


    private loadWallets(): void {
        try {
            const files = fs.readdirSync(this.walletsDir);
            files.forEach(file => {
                if (file.endsWith('.json')) {
                    const walletData = JSON.parse(
                        fs.readFileSync(path.join(this.walletsDir, file), 'utf-8')
                    );
                    this.wallets.set(walletData.publicKey, walletData);
                }
            });
            console.log(chalk.green(`Loaded ${this.wallets.size} existing wallets`));
        } catch (error) {
            console.error(chalk.red('Error loading wallets:'), error);
        }
    }

    public deleteWallet(publicKey: string): boolean {
        try {
            const filename = `wallet-${publicKey.slice(0, 8)}.json`;
            fs.unlinkSync(path.join(this.walletsDir, filename));
            return this.wallets.delete(publicKey);
        } catch (error) {
            console.error(chalk.red('Error deleting wallet:'), error);
            return false;
        }
    }
    

    public async fundWallet(
        connection: Connection,
        mainWallet: Keypair,
        targetPublicKey: string,
        solAmount: number
    ): Promise<boolean> {
        try {
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: mainWallet.publicKey,
                    toPubkey: new PublicKey(targetPublicKey),
                    lamports: solAmount * LAMPORTS_PER_SOL
                })
            );

            const signature = await connection.sendTransaction(transaction, [mainWallet]);
            await connection.confirmTransaction(signature);

            // Update wallet balance in storage
            const newBalance = await connection.getBalance(new PublicKey(targetPublicKey));
            this.updateWalletBalance(targetPublicKey, newBalance / LAMPORTS_PER_SOL);

            return true;
        } catch (error) {
            console.error(chalk.red('Error funding wallet:'), error);
            return false;
        }
    }

    public async fundAllWallets(
        connection: Connection,
        mainWallet: Keypair,
        solAmount: number
    ): Promise<boolean> {
        try {
            const wallets = this.getAllWallets();
            const transaction = new Transaction();
    
            wallets.forEach(wallet => {
                transaction.add(
                    SystemProgram.transfer({
                        fromPubkey: mainWallet.publicKey,
                        toPubkey: new PublicKey(wallet.publicKey),
                        lamports: solAmount * LAMPORTS_PER_SOL
                    })
                );
            });
    
            const signature = await connection.sendTransaction(transaction, [mainWallet]);
            await connection.confirmTransaction(signature);
    
            // Now using the correct method name
            await this.updateAllWalletBalances(connection);
            return true;
        } catch (error) {
            console.error(chalk.red('Error funding wallets:'), error);
            return false;
        }
    }

    public async updateAllWalletBalances(connection: Connection): Promise<void> {
        const wallets = this.getAllWallets();
        for (const wallet of wallets) {
            try {
                const balance = await connection.getBalance(new PublicKey(wallet.publicKey));
                await this.updateWalletBalance(wallet.publicKey, balance / LAMPORTS_PER_SOL);
            } catch (error) {
                console.error(`Error updating balance for wallet ${wallet.publicKey}:`, error);
            }
        }
    }

    public async transferTokensToMain(
        connection: Connection,
        sdk: PumpFunSDK,
        fromWalletPublicKey: string,
        mainWallet: Keypair,
        tokenMint: PublicKey
    ): Promise<boolean> {
        try {
            const fromWallet = this.getWalletKeypair(fromWalletPublicKey);
            if (!fromWallet) {
                throw new Error('Source wallet not found');
            }

            // Get token balance
            const fromAta = await getAssociatedTokenAddress(tokenMint, fromWallet.publicKey);
            const tokenAccount = await getAccount(connection, fromAta);
            const amount = BigInt(tokenAccount.amount);

            // Execute sell transaction
            const sellResults = await sdk.sell(
                fromWallet,
                tokenMint,
                amount,
                BigInt(500), // 5% slippage
                undefined,
                "finalized"
            );

            return sellResults.success;
        } catch (error) {
            console.error(chalk.red('Error transferring tokens:'), error);
            return false;
        }
    }

    public async transferSolToMain(
        connection: Connection,
        fromWalletPublicKey: string,
        mainWallet: Keypair,
        solAmount?: number
    ): Promise<boolean> {
        try {
            const fromWallet = this.getWalletKeypair(fromWalletPublicKey);
            if (!fromWallet) {
                throw new Error('Source wallet not found');
            }
    
            // Get current balance
            const balance = await connection.getBalance(fromWallet.publicKey);
            const transferAmount = solAmount
                ? solAmount * LAMPORTS_PER_SOL
                : balance - (0.001 * LAMPORTS_PER_SOL); // Leave 0.001 SOL for fees
    
            if (transferAmount <= 0) {
                throw new Error('Insufficient balance for transfer');
            }
    
            const transaction = new Transaction().add(
                SystemProgram.transfer({
                    fromPubkey: fromWallet.publicKey,
                    toPubkey: mainWallet.publicKey,
                    lamports: transferAmount
                })
            );
    
            const signature = await connection.sendTransaction(transaction, [fromWallet]);
            await connection.confirmTransaction(signature);
    
            // Update wallet balance
            const newBalance = await connection.getBalance(fromWallet.publicKey);
            await this.updateWalletBalance(fromWalletPublicKey, newBalance / LAMPORTS_PER_SOL);
    
            return true;
        } catch (error) {
            console.error(chalk.red('Error transferring SOL:'), error);
            return false;
        }
    }
    
    public async transferAllToMain(
        connection: Connection,
        sdk: PumpFunSDK,
        fromWalletPublicKey: string,
        mainWallet: Keypair
    ): Promise<boolean> {
        try {
            const fromWallet = this.getWalletKeypair(fromWalletPublicKey);
            if (!fromWallet) {
                throw new Error('Source wallet not found');
            }
    
            // Get all token accounts
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                fromWallet.publicKey,
                { programId: TOKEN_PROGRAM_ID }
            );
    
            // Transfer all tokens
            for (const account of tokenAccounts.value) {
                const mint = new PublicKey(account.account.data.parsed.info.mint);
                const balance = BigInt(account.account.data.parsed.info.tokenAmount.amount);
    
                if (balance > 0) {
                    try {
                        await sdk.sell(
                            fromWallet,
                            mint,
                            balance,
                            BigInt(500), // 5% slippage
                            undefined,
                            "finalized"
                        );
                    } catch (error) {
                        console.error(chalk.yellow(`Failed to transfer token ${mint.toString()}`));
                    }
                }
            }
    
            // Transfer remaining SOL
            await this.transferSolToMain(connection, fromWalletPublicKey, mainWallet);
    
            return true;
        } catch (error) {
            console.error(chalk.red('Error transferring all assets:'), error);
            return false;
        }
    }

    private getWalletKeypair(publicKey: string): Keypair | null {
        const wallet = this.getWallet(publicKey);
        if (!wallet) return null;
        
        try {
            const secretKey = Buffer.from(wallet.privateKey, 'base64');
            return Keypair.fromSecretKey(secretKey);
        } catch (error) {
            console.error(chalk.red('Error creating keypair:'), error);
            return null;
        }
    }

    public async getWalletTokenValues(
        connection: Connection,
        sdk: PumpFunSDK,
        publicKey: string
    ): Promise<{ totalTokenValueUSD: number; tokenCount: number }> {
        try {
            const tokenAccounts = await connection.getParsedTokenAccountsByOwner(
                new PublicKey(publicKey),
                { programId: TOKEN_PROGRAM_ID }
            );

            let totalTokenValueUSD = 0;
            let tokenCount = 0;

            for (const account of tokenAccounts.value) {
                const mint = new PublicKey(account.account.data.parsed.info.mint);
                const balance = Number(account.account.data.parsed.info.tokenAmount.amount);

                if (balance > 0) {
                    try {
                        const bondingCurve = await sdk.getBondingCurveAccount(mint);
                        const globalAccount = await sdk.getGlobalAccount();

                        if (bondingCurve) {
                            const marketCapSOL = Number(bondingCurve.getMarketCapSOL()) / 1e9;
                            const solPrice = await this.getSolPrice();
                            const marketCapUSD = marketCapSOL * solPrice;
                            const totalSupply = Number(globalAccount.tokenTotalSupply);
                            const ownershipPercentage = balance / totalSupply;
                            const valueUSD = marketCapUSD * ownershipPercentage;
                            
                            totalTokenValueUSD += valueUSD;
                            tokenCount++;
                        }
                    } catch (error) {
                        console.debug(`Error getting value for token ${mint.toString()}`);
                    }
                }
            }

            return { totalTokenValueUSD, tokenCount };
        } catch (error) {
            console.error('Error getting wallet token values:', error);
            return { totalTokenValueUSD: 0, tokenCount: 0 };
        }
    }
    
    private async getSolPrice(): Promise<number> {
        try {
            const response = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd');
            const data = await response.json() as { solana: { usd: number } };
            return data.solana.usd;
        } catch (error) {
            console.error('Error fetching SOL price:', error);
            return 0;
        }
    }
    
    public async transferAllWalletsToMain(
        connection: Connection,
        sdk: PumpFunSDK,
        mainWallet: Keypair
    ): Promise<boolean> {
        const wallets = this.getAllWallets();
        let success = true;
    
        console.log(chalk.yellow('\nTransferring assets from all wallets...'));
    
        for (const wallet of wallets) {
            try {
                console.log(chalk.blue(`\nProcessing wallet: ${wallet.publicKey.slice(0, 8)}...`));
                
                const result = await this.transferAllToMain(
                    connection,
                    sdk,
                    wallet.publicKey,
                    mainWallet
                );
    
                if (!result) {
                    console.log(chalk.red(`Failed to transfer assets from wallet ${wallet.publicKey.slice(0, 8)}...`));
                    success = false;
                }
            } catch (error) {
                console.error(chalk.red(`Error processing wallet ${wallet.publicKey.slice(0, 8)}:`), error);
                success = false;
            }
        }
    
        return success;
    }

    private copyTradeConfig: CopyTradeConfig = {
        enabled: false,
        slippageMultiplier: 1.2,    // 20% higher slippage than main wallet
        solAmountMultiplier: 1.0,   // Same SOL amount as main wallet
        maxSolPerTrade: 0.1,        // Max 0.1 SOL per trade per wallet
        priorityFeeMultiplier: 1.2   // 20% higher priority fee than main wallet
    };
    
    public setCopyTradeConfig(config: Partial<CopyTradeConfig>) {
        this.copyTradeConfig = { ...this.copyTradeConfig, ...config };
    }
    
    public async startCopyTrading(
        connection: Connection,
        sdk: PumpFunSDK,
        mainWalletPubkey: PublicKey
    ): Promise<void> {
        if (this.copyTradeConfig.enabled) {
            console.log(chalk.yellow('Copy trading is already enabled'));
            return;
        }
    
        this.copyTradeConfig.enabled = true;
        console.log(chalk.green('Starting copy trading...'));
    
        connection.onLogs(mainWalletPubkey, async (logs) => {
            if (!this.copyTradeConfig.enabled) return;
    
            try {
                // Parse transaction
                const tx = await connection.getParsedTransaction(logs.signature);
                if (!tx?.meta) return;
    
                // Check if this is a pump.fun transaction
                const isPumpFunTx = logs.logs.some(log => 
                    log.includes('Program PumpFunV') || 
                    log.includes('pump.fun')
                );
    
                if (!isPumpFunTx) return;
    
                // Identify if it's a buy or sell
                const isBuy = logs.logs.some(log => log.includes('buy'));
                if (!isBuy) return; // For now, only copy buy trades
    
                // Extract trade details
                const preBalances = tx.meta.preBalances;
                const postBalances = tx.meta.postBalances;
                const solSpent = (preBalances[0] - postBalances[0]) / LAMPORTS_PER_SOL;
    
                // Find the token mint from the transaction
                let tokenMint: PublicKey | null = null;
    
                // Get account keys and ensure they're PublicKeys
                const accountKeys = tx.transaction.message.accountKeys.map(key => {
                    if (typeof key === 'string') {
                        return new PublicKey(key);
                    }
                    // Handle ParsedMessageAccount type
                    if ('pubkey' in key) {
                        return key.pubkey;
                    }
                    // If it's already a PublicKey, return it
                    if (typeof key === 'string') {
                        return key;
                      }
                    // For any other case, try to create a PublicKey from toString()
                    return new PublicKey(key);
                });
    
                // Look for the token mint
                for (const account of accountKeys) {
                    try {
                        const accountInfo = await connection.getAccountInfo(account);
                        if (accountInfo?.owner.toString() === 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') {
                            // This is likely our token mint
                            tokenMint = account;
                            break;
                        }
                    } catch (error) {
                        console.debug(`Error checking account ${account.toString()}:`, error);
                        continue;
                    }
                }
    
                // Fallback: Look for account that appears in the right position
                if (!tokenMint) {
                    const instructions = tx.transaction.message.instructions;
                    const potentialMintIndex = instructions.findIndex(ix => {
                        if ('programId' in ix) {
                            return ix.programId.toString() === 'PumpFunV1111111111111111111111111111111111';
                        }
                        return false;
                    });
    
                    if (potentialMintIndex >= 0 && accountKeys[potentialMintIndex + 1]) {
                        tokenMint = accountKeys[potentialMintIndex + 1];
                    }
                }
    
                if (!tokenMint) {
                    console.error(chalk.red('Could not extract token mint from transaction'));
                    return;
                }
    
                // Calculate amounts for copy trade
                const copyTradeAmount = Math.min(
                    solSpent * this.copyTradeConfig.solAmountMultiplier,
                    this.copyTradeConfig.maxSolPerTrade
                );
    
                // Extract original transaction's priority fee if any
                let priorityFee: { unitPrice: number; unitLimit: number } | undefined;
                if (tx.meta.computeUnitsConsumed) {
                    const originalPriorityFee = tx.meta.computeUnitsConsumed / 100000; // Approximate
                    priorityFee = {
                        unitPrice: originalPriorityFee * this.copyTradeConfig.priorityFeeMultiplier,
                        unitLimit: 250000,
                    };
                }
    
                // Execute copy trades
                console.log(chalk.blue('\nDetected buy transaction:'));
                console.log(chalk.blue(`Token: ${tokenMint.toString()}`));
                console.log(chalk.blue(`Amount: ${solSpent} SOL`));
                console.log(chalk.blue(`Copy amount per wallet: ${copyTradeAmount} SOL`));
    
                await this.executeBuyFromAllWallets(
                    connection,
                    sdk,
                    tokenMint,
                    copyTradeAmount,
                    5 * this.copyTradeConfig.slippageMultiplier,
                    priorityFee
                );
    
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error in copy trade';
                console.error(chalk.red('Error in copy trade:'), errorMessage);
            }
        });
    }
    
    public stopCopyTrading() {
        this.copyTradeConfig.enabled = false;
        console.log(chalk.yellow('Copy trading stopped'));
    }

    public async executeBuyFromWallet(
        connection: Connection,
        sdk: PumpFunSDK,
        walletPublicKey: string,
        tokenMint: PublicKey,
        solAmount: number,
        slippage: number = 5,
        priorityFee?: { unitPrice: number; unitLimit: number }
    ): Promise<BuyResults> {
        try {
            const wallet = this.getWalletKeypair(walletPublicKey);
            if (!wallet) {
                return { success: false, error: 'Source wallet not found' };
            }
    
            const balance = await connection.getBalance(wallet.publicKey);
            if (balance < solAmount * LAMPORTS_PER_SOL) {
                return { success: false, error: 'Insufficient balance for transaction' };
            }
    
            const buyResults = await sdk.buy(
                wallet,
                tokenMint,
                BigInt(solAmount * LAMPORTS_PER_SOL),
                BigInt(slippage * 100),
                priorityFee,
                "finalized"
            ) as SDKBuyResult;
    
            if (buyResults.success) {
                await this.updateWalletBalance(
                    walletPublicKey,
                    (await connection.getBalance(wallet.publicKey)) / LAMPORTS_PER_SOL
                );
                return { 
                    success: true, 
                    signature: buyResults.signature 
                };
            } else {
                const errorMessage = typeof buyResults.error === 'object' 
                    ? buyResults.error.message 
                    : String(buyResults.error || 'Unknown error');
                return { 
                    success: false, 
                    error: errorMessage 
                };
            }
        } catch (error) {
            const errorMessage = error instanceof Error ? error.message : 'Unknown error';
            return { 
                success: false, 
                error: errorMessage 
            };
        }
    }
    
    public async executeBuyFromAllWallets(
        connection: Connection,
        sdk: PumpFunSDK,
        tokenMint: PublicKey,
        solAmount: number,
        slippage: number = 5,
        priorityFee?: { unitPrice: number; unitLimit: number }
    ): Promise<{ success: boolean; results: { walletKey: string; success: boolean; error?: string }[] }> {
        const wallets = this.getAllWallets();
        const results: { walletKey: string; success: boolean; error?: string }[] = [];
        let overallSuccess = true;
    
        for (const wallet of wallets) {
            console.log(chalk.blue(`\nProcessing buy for wallet: ${wallet.publicKey.slice(0, 8)}...`));
            
            const result = await this.executeBuyFromWallet(
                connection,
                sdk,
                wallet.publicKey,
                tokenMint,
                solAmount,
                slippage,
                priorityFee
            );
    
            results.push({
                walletKey: wallet.publicKey,
                success: result.success,
                error: result.error
            });
    
            if (!result.success) {
                overallSuccess = false;
                console.log(chalk.red(`Failed: ${result.error}`));
            } else {
                console.log(chalk.green('Success'));
            }
        }
    
        return { success: overallSuccess, results };
    }

    public deleteAllWallets(): boolean {
        try {
            const files = fs.readdirSync(this.walletsDir);
            files.forEach(file => {
                if (file.endsWith('.json')) {
                    fs.unlinkSync(path.join(this.walletsDir, file));
                }
            });
            this.wallets.clear();
            return true;
        } catch (error) {
            console.error(chalk.red('Error deleting all wallets:'), error);
            return false;
        }
    }

    public storeWallet(keypair: Keypair, label?: string): StoredWallet {
        const walletData: StoredWallet = {
            publicKey: keypair.publicKey.toString(),
            privateKey: Buffer.from(keypair.secretKey).toString('base64'),
            label,
            createdAt: new Date(),
            balance: 0
        };

        const filename = `wallet-${walletData.publicKey.slice(0, 8)}.json`;
        fs.writeFileSync(
            path.join(this.walletsDir, filename),
            JSON.stringify(walletData, null, 2)
        );

        this.wallets.set(walletData.publicKey, walletData);
        return walletData;
    }

    public getAllWallets(): StoredWallet[] {
        return Array.from(this.wallets.values());
    }

    public getWallet(publicKey: string): StoredWallet | undefined {
        return this.wallets.get(publicKey);
    }

    public async updateWalletBalance(publicKey: string, balance: number): Promise<void> {
        const wallet = this.wallets.get(publicKey);
        if (wallet) {
            wallet.balance = balance;
            wallet.lastUsed = new Date();
            
            const filename = `wallet-${publicKey.slice(0, 8)}.json`;
            fs.writeFileSync(
                path.join(this.walletsDir, filename),
                JSON.stringify(wallet, null, 2)
            );
        }
    }
}